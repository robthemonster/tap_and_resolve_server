let cards = require("./scryfall-default-cards");
let fs = require('fs');

let privateKey = fs.readFileSync('./cert/privkey.pem', 'utf8');
let cert = fs.readFileSync('./cert/fullchain.pem', 'utf8');
let credentials = {key: privateKey, cert: cert};

let aws = require('aws-sdk');
aws.config.update({region: 'us-east-2', accessKeyId: process.env.AWS_API_ID, secretAccessKey: process.env.AWS_API_KEY});
let db = new aws.DynamoDB({apiVersion: '2019-02-16'});
const LIKED_TABLE = "cards_liked";
const BLOCKED_TABLE = "cards_blocked";

function putCardInTable(tablename, userid, uuid) {
    return db.putItem({
        TableName: tablename,
        Item: {'userid': {'S': userid}, 'uuid': {'S': uuid}, 'timestamp': {'N': Date.now().toString()}}
    }).promise();
}

const userId = "d1fbbe6f-1dcf-4442-95a8-8180d772c48e";
for (let card in cards) {
    putCardInTable(BLOCKED_TABLE, userId, cards[card].id);
}
