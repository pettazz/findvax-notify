const secrets = require('./secrets.js');
const AWS = require('aws-sdk');

const util = require('util');

const responseHeaders = {
  'Access-Control-Allow-Headers' : 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'OPTIONS,PUT'
};

const msgTemplate = {
  en: {
    start: 'Findvax.us found available slots:\n\n',
    end: '\n\nWe\'ll stop notifying you for these locations now. Re-subscribe on the site if needed.'
  }
};

const handleAPIRequest = (event, successHandler, failureHandler) => {
  const db = new AWS.DynamoDB.DocumentClient({apiVersion: '2012-08-10'});

  const validateUUID = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/;
  const requiredFields = ['location', 'sms', 'lang'];
  let body;
  
  if(!event || !event.body || !event.body.trim().length > 0){
    throw 'Missing request body!';
  }

  body = JSON.parse(event.body.trim());
  console.log('Parsed request body: ', JSON.stringify(body));

  // i know apigw validates the request body against a jsonschema, 
  // but it's not like this is horribly expensive and it makes me feel better okay
  requiredFields.forEach((field) => {
    if(!(Object.keys(body).includes(field) && body[field].length > 0)){
      throw `Missing or incorrect type for required field \`${field}\` in body!`;
    }
  })

  const location = body.location,
        lang = body.lang,
        sms = '+1' + body.sms.replace(/\D/g, '');

  if(!validateUUID.test(location)){
    throw 'Invalid location uuid!';
  }
  if(!sms.length === 12){
    throw 'Invalid US phone number!';
  }
  if(!typeof lang === "string" && !lang.length == 2){
    throw 'Invalid language id (must be a two char string without localization like "en" or "fr")!';
  }

  let params = {
    TableName: 'notify',
    Item: {
      location: location,
      isSent: 0,
      sms: sms,
      lang: lang
    }
  };

  db.put(params, (err, data) => {
    if(err){
      console.error('Unable to add notifcation db item.');
      failureHandler(err);
    }else{
      console.log('Added notification db item:', JSON.stringify(data));
      successHandler();
    }
  });

}

const getAvailabilityData = (state) => {
  const s3 = new AWS.S3({apiVersion: '2006-03-01'});

  const availabilityParams = {
    Bucket: 'findvax-data',
    Key: `${state}/availability.json`
  },
        locationsParams = {
    Bucket: 'findvax-data',
    Key: `${state}/locations.json`
  };

  let loadedData = {},
      locationAvailability = [];

  return Promise.all([
    s3.getObject(availabilityParams).promise().then(data => {
      loadedData.availability = JSON.parse(data.Body.toString('utf-8'));
    }).catch(err => {
      console.error(`can't load availability.json:`);
      console.error(util.inspect(availabilityParams, false, 5));
      console.error(util.inspect(err, false, 5));
      throw err;
    }),
    s3.getObject(locationsParams).promise().then(data => {
      loadedData.locations = JSON.parse(data.Body.toString('utf-8'));
    }).catch(err => {
      console.error(`can't load locations.json:`);
      console.error(util.inspect(locationsParams, false, 5));
      console.error(util.inspect(err, false, 5));
      throw err;
    })
  ]).then(() => {
    if((loadedData.locations && loadedData.locations.length > 0) ||
       (loadedData.availability && loadedData.availability.length > 0)){
        
        locationAvailability = loadedData.locations.map((location) => {
          let locationDetail = null;
          const foundAvailability = loadedData.availability.find(avail => avail && avail.location && avail.location === location.uuid) || null;
        
          if (foundAvailability &&
              foundAvailability.times &&
              foundAvailability.times.length > 0){

            let timeslots = foundAvailability.times.reduce((acc, avail) => {
              if(avail.slots === null){
                // since we don't have a specific count for this time slot, just use
                // an arbitrary large number to ensure it's above any threshold
                return acc + 100; 
              }

              return acc + parseInt(avail.slots);
            }, 0);

            // if we dont have more slots than this location's threshold.
            // prevents sending an sms for 1 slot that was gone 45 seconds
            // before this script even got triggered.
            if(!location.notificationThreshold || timeslots > location.notificationThreshold){
              locationDetail = {
                uuid: location.uuid,
                name: location.name,
                url: location.linkUrl
              };  
            }
          }

          return locationDetail;
        });
    }

    return locationAvailability;
  });
}

const sendNotifications = (locations, successHandler, failureHandler) => {
  const db = new AWS.DynamoDB.DocumentClient({apiVersion: '2012-08-10'}),
        pinpoint = new AWS.Pinpoint({apiVersion: '2016-12-01'});

  let notisToSend = {};

  let q = [];
  locations.forEach(location => {
    if(location){

      const params = {
        TableName: 'notify',
        ProjectionExpression: '#loc, #st, sms, lang',
        KeyConditionExpression: '#loc = :id and #st = :no',
        ExpressionAttributeNames: {
          '#loc': 'location',
          '#st': 'isSent'
        },
        ExpressionAttributeValues: {
          ':id': location.uuid,
          ':no': 0
        }
      };

      const queryPromise = db.query(params).promise().then(data => {
        data.Items.forEach(noti => {
          if(!Object.keys(notisToSend).includes(noti.sms)){
            notisToSend[noti.sms] = {lang: noti.lang, locations: []};
          }
          notisToSend[noti.sms].locations.push({name: location.name, link: location.url, uuid: location.uuid});
        }); 
      }).catch(err => {
        failureHandler(err);
      });
      
      q.push(queryPromise);
    }
  });

  return Promise.all(q).then(() => {
    let smsQ = [],
        msgCounter = 0;

    console.log(`Sending ${Object.keys(notisToSend).length} notifications:`);
    console.log(util.inspect(notisToSend, false, 5));

    for(const [sms, details] of Object.entries(notisToSend)){
      notisToSend[sms]['status'] = 'unsent';

      let lang = details.lang || 'en';
      if(!Object.keys(msgTemplate).includes(lang)){
        console.log(`Unrecognized lang id: '${lang}', defaulting to 'en'`);
        lang = 'en';
      }

      let msg = details.locations.reduce((msg, next) => {
        return msg + `${next.name}: ${next.link}\n`;
      }, msgTemplate[lang].start);
      msg += msgTemplate[lang].end;
    
      const msgParams = {
        ApplicationId: secrets.applicationId,
        MessageRequest: {
          Addresses: {
            [sms]: {
              ChannelType: 'SMS'
            }
          },
          MessageConfiguration: {
            SMSMessage: {
              Body: msg,
              MessageType: 'TRANSACTIONAL',
              OriginationNumber: secrets.originationNumber
            }
          }
        }
      };

      notisToSend[sms]['status'] = 'pending';

      smsQ.push(pinpoint.sendMessages(msgParams).promise().then(data => {
        console.log("Message sent:");
        console.log(util.inspect(data, false, 5));
        msgCounter++;

        let sms = Object.keys(data.MessageResponse.Result)[0];
        notisToSend[sms]['status'] = 'success';
      }).catch(err => {
        console.error("Message failed sending:");
        console.error(util.inspect(err, false, 5));
        throw err;
      }));
    }

    return Promise.all(smsQ).then(() => {
      if(msgCounter > 0){
        let deleteQ = [];

        console.log(`Sent ${msgCounter} messages.`);
        for(const [sms, details] of Object.entries(notisToSend)){
          if(details.status === 'success'){
            details.locations.forEach(location => {
  
              const params = {
                TableName: 'notify',
                Key:{
                    'location': location.uuid,
                    'isSent': 0
                },
                ConditionExpression:"sms = :val",
                ExpressionAttributeValues: {
                    ":val": sms
                }
              };
    
              console.log('queued item for deletion:');
              console.log(params);
              const deletePromise = db.delete(params).promise().then(res => {
                console.log('deleted item successfully:');
                console.log(util.inspect(res, false, 5));
              });
              deleteQ.push(deletePromise);
            });
          }else{
            console.error(`non-success status for ${sms}:`);
            console.error(util.inspect(details, false, 5));
          }
        };

        return Promise.all(deleteQ).then((res) => {
            console.log('Removed db entries.');
            successHandler();

          }).catch(err => {
            failureHandler(err);
          });
      }else{
        console.log('Nothing to remove. Exiting.');
        successHandler();      
      }

    }).catch(err => {
      failureHandler(err);
    });

  }).catch(err => {
    failureHandler(err);
  });
}

exports.handler = (event, context, callback) => {
  // declare within the scope of the handler so we can pass them around for reuse
  const rb = callback;
  const win = () => {
    rb(null, {
      isBase64Encoded: false,
      statusCode: 200,
      headers: responseHeaders,
      multiValueHeaders: {},
      body: ""
    });
  }
  const die = (error) => {
    let statusCode = 500,
        errorBody = `{ "message": "Something went wrong! Unable to get error details."}`;

    console.error(JSON.stringify(error));
    if(typeof error === "string"){

      if(error.startsWith('Missing ') || error.startsWith('Invalid ')){
        statusCode = 400;
      }

      errorBody = `{ "message": "${error}"}`;
    }else{
      // 5xx errors
      if(error.code){
        errorBody = `{ "message": "Function execution error: ${error.code}: ${error.message}"}`;
      }else if(error.message){
        errorBody = `{ "message": "Function execution error: ${error.message}"}`;
      }
    }

    rb(null, {
      isBase64Encoded: false,
      statusCode: statusCode,
      headers: responseHeaders,
      multiValueHeaders: {},
      body: errorBody
    });
  }

  // detect where this came from and how to handle it
  try{

    if(event.httpMethod){
      // this was triggered by API Gateway
      handleAPIRequest(event, win, die);
    }else if(event.responsePayload){
      // this was triggered by the previous lambda
      const reqState = event.responsePayload.state,
            isInit = event.requestPayload.init;
      if(!reqState){
        throw 'Missing state param!';
      }
      if(isInit || reqState === 'none'){
        context.callbackWaitsForEmptyEventLoop = false;
        // special case to skip doing anything when this was triggered by the scraper init job
        console.log('init, exiting.');
        win();
      }else{
        console.log(`Checking for ${reqState}`);
        return getAvailabilityData(reqState).then(data => sendNotifications(data, win, die)); 
      }

    }else{
      throw 'Unknown trigger! I dunno how to handle this!';
    }

  }catch(error){
    die(error);
  }
};
