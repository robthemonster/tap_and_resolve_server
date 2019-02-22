'use strict';

let dotenv = require('dotenv');
dotenv.config();

let express = require('express');
let app = express();
let bodyParser = require('body-parser');
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));
let https = require('https');

let fs = require('fs');
let cards = require("./scryfall-default-cards");
let uuidToIndex = {};
for (let i = 0; i < cards.length; i++) {
    uuidToIndex[cards[i].id] = i;
}

let privateKey = fs.readFileSync('./cert/privkey.pem', 'utf8');
let cert = fs.readFileSync('./cert/fullchain.pem', 'utf8');
let credentials = {key: privateKey, cert: cert};

let aws = require('aws-sdk');
aws.config.update({region: 'us-east-2', accessKeyId: process.env.AWS_API_ID, secretAccessKey: process.env.AWS_API_KEY});
let db = new aws.DynamoDB({apiVersion: '2019-02-16'});
const LIKED_TABLE = "cards_liked";
const BLOCKED_TABLE = "cards_blocked";

function randomInt(min, max) {
    return min + Math.floor(Math.random() * (max - min));
}

let httpsServer = https.createServer(credentials, app);

app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

function queryAllForUserParams(tablename, userid) {
    return {
        TableName: tablename,
        KeyConditionExpression: "userid = :userid",
        ExpressionAttributeValues: {":userid": {'S': userid}}
    };
}

function getAllFromTable(tablename, userid, res) {
    let cardsInTable = [];
    db.query(queryAllForUserParams(tablename, userid)).promise().then(result => {
        result.Items.forEach(item => {
            let uuid = item.uuid.S;
            cardsInTable.push(cards[uuidToIndex[uuid]]);
        });
        cardsInTable.sort((a, b) => {
            return a.name < b.name ? -1 : 1
        });
        res.json(cardsInTable);
    });
}

function putCardInTable(tablename, userid, uuid, res) {
    db.putItem({TableName: tablename, Item: {'userid': {'S': userid}, 'uuid': {'S': uuid}}}).promise()
        .then(result => {
            res.json(result);
        })
        .catch(error => {
            console.log(error);
        });
}

function removeCardFromTable(tablename, userid, uuid, res) {
    db.deleteItem({TableName: tablename, Key: {'userid': {'S': userid}, 'uuid': {'S': uuid}}}).promise()
        .then(result => {
            res.json(result);
        })
        .catch(error => {
            console.log(error);
        });
}

app.post('/getBlocked', (req, res, next) => {
    let userid = req.body.userid;
    getAllFromTable(BLOCKED_TABLE, userid, res)
});

app.post('/getLiked', (req, res, next) => {
    let userid = req.body.userid;
    getAllFromTable(LIKED_TABLE, userid, res);
});

app.post('/addCardToLiked', (req, res, next) => {
    let userid = req.body.userid;
    let uuid = req.body.uuid;
    putCardInTable(LIKED_TABLE, userid, uuid, res);
});

app.post('/addCardToBlocked', (req, res, next) => {
    let userid = req.body.userid;
    let uuid = req.body.uuid;
    putCardInTable(BLOCKED_TABLE, userid, uuid, res);

});

app.post('/removeCardFromLiked', (req, res, next) => {
    let userid = req.body.userid;
    let uuid = req.body.uuid;
    removeCardFromTable(LIKED_TABLE, userid, uuid, res);
});

app.post('/removeCardFromBlocked', (req, res, next) => {
    let userid = req.body.userid;
    let uuid = req.body.uuid;
    removeCardFromTable(BLOCKED_TABLE, userid, uuid, res);
});

app.post('/getUserCardStatus', (req, res, next) => {
    let userid = req.body.userid;
    let uuid = req.body.uuid;

    let existsInLikedParams = {
        TableName: LIKED_TABLE,
        KeyConditionExpression: "userid = :userid and #uuid = :uuid",
        ExpressionAttributeValues: {":userid": {'S': userid}, ':uuid': {'S': uuid}},
        ExpressionAttributeNames: {"#uuid": "uuid"}
    };
    let existsInBlockedParams = {
        TableName: BLOCKED_TABLE,
        KeyConditionExpression: "userid = :userid and #uuid = :uuid",
        ExpressionAttributeValues: {":userid": {'S': userid}, ':uuid': {'S': uuid}},
        ExpressionAttributeNames: {"#uuid": "uuid"}
    };
    Promise.all([db.query(existsInLikedParams).promise(), db.query(existsInBlockedParams).promise()])
        .then(([resLiked, resBlocked]) => {
            res.json({liked: resLiked.Count > 0, blocked: resBlocked.Count > 0});
        });
});

app.post('/searchForCard', (req, res, next) => {
    let searchString = req.body.searchString.toLowerCase();
    if (searchString.length < 3) {
        res.json({results: [[]], autocomplete: {}});
        return;
    }
    let userid = req.body.userid;
    let pagesize = req.body.pagesize;
    let likedParams = queryAllForUserParams(LIKED_TABLE, userid);
    let blockedParams = queryAllForUserParams(BLOCKED_TABLE, userid);
    let taken = new Set();
    let liked_promise = db.query(likedParams).promise();
    let blocked_promise = db.query(blockedParams).promise();
    Promise.all([liked_promise, blocked_promise]).then(([res1, res2]) => {
        res1.Items.forEach(item => {
            taken.add(item.uuid);
        });
        res2.Items.forEach(item => {
            taken.add(item.uuid);
        });
    });
    let results = [];
    for (let index in cards) {
        let card = cards[index];
        if (!taken.has(card.id) && card.name.toLowerCase().includes(searchString)) {
            results.push(card);
        }
    }
    results.sort((a, b) => {
        return a.name.toLowerCase().indexOf(searchString) - b.name.toLowerCase().indexOf(searchString)
    });
    let pageCtr = 0;
    let paginatedResults = [[]];
    for (let i = 0; i < results.length; i++) {
        if (paginatedResults[pageCtr].length >= pagesize) {
            pageCtr++;
            paginatedResults[pageCtr] = [];
        }
        paginatedResults[pageCtr].push(results[i]);
    }
    let autocomplete = {};
    for (let i = 0; i < results.length - 1 && Object.keys(autocomplete).length < 10; i++) {
        autocomplete[results[i].name] = (results[i].image_uris) ? results[i].image_uris.small : null;
    }
    res.json({results: paginatedResults, autocomplete: autocomplete});
});

app.post("/randomCard", (req, res, next) => {
    let userid = req.body.userid;
    let uuid = cards[randomInt(0, cards.length - 1)].id;
    let likedParams = queryAllForUserParams(LIKED_TABLE, userid);
    let blockedParams = queryAllForUserParams(BLOCKED_TABLE, userid);
    let liked_promise = db.query(likedParams).promise();
    let blocked_promise = db.query(blockedParams).promise();

    Promise.all([liked_promise, blocked_promise]).then(([res1, res2]) => {
        let taken = new Set();
        res1.Items.forEach(item => {
            taken.add(item.uuid);
        });
        res2.Items.forEach(item => {
            taken.add(item.uuid);
        });
        if (taken.has(uuid)) {
            if (taken.size >= cards.length / 2) {
                let rand = [];
                for (let i = 0; i < cards.length; i++) {
                    let uuid = cards[i].id;
                    if (!taken.has(uuid)) {
                        rand.push(uuid);
                    }
                }
                uuid = rand[randomInt(0, rand.length - 1)];
            } else {
                while (taken.has(uuid)) {
                    uuid = cards[randomInt(0, cards.length - 1)].id;
                }
            }
        }
        res.json(cards[uuidToIndex[uuid]]);
    });
});

httpsServer.listen(443, () => console.log('listening'));