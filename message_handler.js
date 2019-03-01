'use strict';

const AUTH_FAILED_MESSAGE = "Failed to authenticate user";
const NO_CARD_REMAINING_MESSAGE = "No cards remaining";
const DB_WRITE_ERROR_MESSAGE = "Error writing to database";

let dotenv = require('dotenv');
let AUTH_SERVER = "tapandresolve.tk";
let AUTH_PATH = "/.netlify/identity/user";
dotenv.config();

let express = require('express');
let app = express();
let bodyParser = require('body-parser');
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));
let https = require('https');

const SORTERS = {
    'TOP': (b, a) => {
        return (a.likedCount - a.dislikedCount) - (b.likedCount - b.dislikedCount)
    },
    'CONTROVERSIAL': (b, a) => {
        return ((a.likedCount + a.dislikedCount) / Math.max(Math.abs(a.likedCount - a.dislikedCount), 1))
            - ((b.likedCount + b.dislikedCount) / Math.max(Math.abs(b.likedCount - b.dislikedCount), 1));
    }
};
let fs = require('fs');
let cards = require("./scryfall-default-cards");
let uuidToIndex = {};
let cardsContainingColor = {"R": new Set(), "U": new Set(), "G": new Set(), "B": new Set(), "W": new Set()};
let formatsContainingCards = {};
let lands = new Set();
let commanders = new Set();
let cardTypes = {};
let removedCtr = 0;

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

function putCardInTable(tablename, userid, uuid) {
    return db.putItem({TableName: tablename, Item: {'userid': {'S': userid}, 'uuid': {'S': uuid}}}).promise();
}

function removeCardFromTable(tablename, userid, uuid) {
    return db.deleteItem({TableName: tablename, Key: {'userid': {'S': userid}, 'uuid': {'S': uuid}}}).promise();
}

function authenticateUser(userid, token) {
    return new Promise((resolve, reject) => {
        let options = {
            hostname: AUTH_SERVER,
            path: AUTH_PATH,
            port: 443,
            method: 'GET',
            headers: {Authorization: `Bearer ${token}`}
        };
        let auth_req = https.request(options, (responseFromAuthServer) => {
            responseFromAuthServer.on('data', userDataResponse => {
                let userData = JSON.parse(userDataResponse);
                if (userData.id === userid) {
                    resolve();
                } else {
                    reject(new Error(AUTH_FAILED_MESSAGE));
                }
            })
        });
        auth_req.on('error', (err => {
            reject(new Error(AUTH_FAILED_MESSAGE));
        }));
        auth_req.end();
    });
}

async function preprocess() {

    for (let i = 0; i < cards.length; i++) {
        cards[i].likedCount = 0;
        cards[i].dislikedCount = 0;
        let card = cards[i];
        if (card.lang !== "en" || !card.image_uris || card.type_line.includes('Basic Land')) {
            cards.splice(i, 1);
            i--;
            removedCtr++;
            continue;
        }
        uuidToIndex[card.id] = i;
        let colors = card.colors;
        if (colors) {
            colors.forEach(color => {
                cardsContainingColor[color].add(card.id);
            });
        }
        let legalities = card.legalities;
        for (let format in legalities) {
            if (!formatsContainingCards[format]) {
                formatsContainingCards[format] = new Set();
            }
            if (legalities[format] === 'legal') {
                formatsContainingCards[format].add(card.id)
            }
        }
        let type = card.type_line.split("—")[0];
        type = type.replace(/\s/g, '');
        if (!cardTypes[type]) {
            cardTypes[type] = new Set();
        }
        cardTypes[type].add(card.id);
        if (type.toLowerCase().includes('land')) {
            lands.add(card.id);
        }
        if (formatsContainingCards['commander'].has(card.id) && card.layout !== 'meld') {
            if (type.toLowerCase().includes('legendary') && type.toLowerCase().includes('creature')) {
                commanders.add(card.id);
            } else if (type.toLowerCase().includes('planeswalker') && card.oracle_text && card.oracle_text.includes(`${card.name} can be your commander`)) {
                commanders.add(card.id);
            }
        }

    }
    console.log(`removed ${removedCtr} from dataset`);
    await new Promise((resolve, reject) => {
        db.scan({TableName: LIKED_TABLE}, (error, data) => {
            if (error) {
                console.log(error);
                reject();
            }
            data.Items.forEach(item => {
                if (!cards[uuidToIndex[item.uuid.S]]) {
                    console.log(item.uuid.S + " not found in cards array");
                } else {
                    cards[uuidToIndex[item.uuid.S]].likedCount++;
                }
            });
            resolve();
        });
    });
    await new Promise((resolve, reject) => {
        db.scan({TableName: BLOCKED_TABLE}, (error, data) => {
            if (error) {
                console.log(error);
                reject();
            }
            data.Items.forEach(item => {
                if (!cards[uuidToIndex[item.uuid.S]]) {
                    console.log(item.uuid.S + " not found in cards array");
                } else {
                    cards[uuidToIndex[item.uuid.S]].dislikedCount++;
                }
            });
            resolve();
        });
    });
}

app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

app.post('/getTopCards', (req, res, next) => {
    let sort = req.body.sort;
    let sorted = cards.concat().sort(SORTERS[sort]).splice(0, 100);
    res.json(sorted);
});

app.post('/handleIdentityEvent', (req, res, next) => {
    let event = req.body.event;
    console.log(event);
});

app.post('/getBlocked', (req, res, next) => {
    let userid = req.body.userid;
    let token = req.body.token;
    authenticateUser(userid, token)
        .then(() => {
            getAllFromTable(BLOCKED_TABLE, userid, res)
        })
        .catch(() => {
            res.status(401).send({message: AUTH_FAILED_MESSAGE});
        });
});

app.post('/getLiked', (req, res, next) => {
    let userid = req.body.userid;
    let token = req.body.token;
    authenticateUser(userid, token)
        .then(() => {
            getAllFromTable(LIKED_TABLE, userid, res);
        })
        .catch(() => {
            res.status(401).send({message: AUTH_FAILED_MESSAGE});
        });
});

app.post('/addCardToLiked', (req, res, next) => {
    let userid = req.body.userid;
    let token = req.body.token;
    let uuid = req.body.uuid;
    authenticateUser(userid, token)
        .then(() => {
            putCardInTable(LIKED_TABLE, userid, uuid)
                .then(() => {
                    cards[uuidToIndex[uuid]].likedCount++;
                    res.json(cards[uuidToIndex[uuid]]);
                })
                .catch(() => {
                    res.status(500).send({message: DB_WRITE_ERROR_MESSAGE});
                });
        })
        .catch((err) => {
            res.status(401).send({message: AUTH_FAILED_MESSAGE});
        });
});

app.post('/addCardToBlocked', (req, res, next) => {
    let userid = req.body.userid;
    let token = req.body.token;
    let uuid = req.body.uuid;
    authenticateUser(userid, token)
        .then(() => {
            putCardInTable(BLOCKED_TABLE, userid, uuid)
                .then(() => {
                    cards[uuidToIndex[uuid]].dislikedCount++;
                    res.json(cards[uuidToIndex[uuid]]);
                })
                .catch(() => {
                    res.status(500).send({message: DB_WRITE_ERROR_MESSAGE});
                });
        })
        .catch((err) => {
            res.status(401).send({message: AUTH_FAILED_MESSAGE});
        });
});

app.post('/removeCardFromLiked', (req, res, next) => {
    let userid = req.body.userid;
    let token = req.body.token;
    let uuid = req.body.uuid;
    authenticateUser(userid, token)
        .then(() => {
            removeCardFromTable(LIKED_TABLE, userid, uuid)
                .then(() => {
                    cards[uuidToIndex[uuid]].likedCount--;
                    res.json(cards[uuidToIndex[uuid]]);
                })
                .catch(() => {
                    res.status(500).send({message: DB_WRITE_ERROR_MESSAGE});
                });
        })
        .catch((err) => {
            res.status(401).send({message: AUTH_FAILED_MESSAGE});
        });
});

app.post('/removeCardFromBlocked', (req, res, next) => {
    let userid = req.body.userid;
    let token = req.body.token;
    let uuid = req.body.uuid;
    authenticateUser(userid, token)
        .then(() => {
            removeCardFromTable(BLOCKED_TABLE, userid, uuid)
                .then(() => {
                    cards[uuidToIndex[uuid]].dislikedCount--;
                    res.json(cards[uuidToIndex[uuid]]);
                })
                .catch(() => {
                    res.status(500).send({message: DB_WRITE_ERROR_MESSAGE});
                });
        })
        .catch((err) => {
            res.status(401).send({message: AUTH_FAILED_MESSAGE});
        });
});

app.post('/getUserCardStatus', (req, res, next) => {
    let userid = req.body.userid;
    let token = req.body.token;
    let uuid = req.body.uuid;
    authenticateUser(userid, token).then(() => {
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
    }).catch(() => {
        res.status(401).send({message: AUTH_FAILED_MESSAGE});
    });
});

app.post('/searchForCard', (req, res, next) => {
    if (!req.body.searchString || req.body.searchString.length < 3) {
        res.json({cards: [], numPages: 0});
        return;
    }
    let searchString = req.body.searchString.toLowerCase();
    let pageNumber = req.body.pageNumber;
    let pageSize = req.body.pageSize;
    let taken = new Set();
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
    let page = [];
    for (let i = pageNumber * pageSize; i < (pageNumber + 1) * pageSize && i < results.length; i++) {

        page.push(results[i]);
    }
    res.json({cards: page, numPages: Math.ceil(results.length / pageSize)});
});

app.post("/randomCard", (req, res, next) => {
    let userid = req.body.userid;
    let token = req.body.token;
    let uuid = cards[randomInt(0, cards.length)].id;
    let filterSettings = JSON.parse(req.body.filter);
    let colorExclusive = filterSettings.colorExclusive;
    let colorFlags = filterSettings.colorFlags;
    let formatFlags = filterSettings.formatFlags;
    let allowLands = filterSettings.allowLands;
    let commandersOnly = filterSettings.commandersOnly;

    let likedParams = queryAllForUserParams(LIKED_TABLE, userid);
    let blockedParams = queryAllForUserParams(BLOCKED_TABLE, userid);
    let liked_promise = new Promise((resolve, reject) => {
        resolve({Items: []})
    });
    let blocked_promise = new Promise((resolve, reject) => {
        resolve({Items: []})
    });
    let authentication = new Promise((resolve, reject) => {
        resolve()
    });
    if (userid && token) {
        authentication = new Promise((resolve, reject) => {
            authenticateUser(userid, token).then(() => {
                liked_promise = db.query(likedParams).promise();
                blocked_promise = db.query(blockedParams).promise();
                resolve();
            }).catch((error) => {
                reject(error)
            });
        });
    }
    authentication.then(() => {
        Promise.all([liked_promise, blocked_promise]).then(([res1, res2]) => {
            let excluded = new Set();
            res1.Items.forEach(item => {
                excluded.add(item.uuid.S);
            });
            res2.Items.forEach(item => {
                excluded.add(item.uuid.S);
            });
            if (filterSettings) {
                cards.forEach(card => {
                    for (let color in colorFlags) {
                        if (colorFlags[color]) {
                            if (colorExclusive) {
                                if (!cardsContainingColor[color].has(card.id)) {
                                    excluded.add(card.id);
                                }
                            }
                        } else {
                            if (cardsContainingColor[color].has(card.id)) {
                                excluded.add(card.id);
                            }
                        }
                    }
                    for (let format in formatFlags) {
                        if (formatFlags[format] && !formatsContainingCards[format].has(card.id)) {
                            excluded.add(card.id);
                        }
                    }
                    if (!allowLands && lands.has(card.id)) {
                        excluded.add(card.id);
                    }
                    if (commandersOnly && !commanders.has(card.id)) {
                        excluded.add(card.id);
                    }
                });
            }
            if (excluded.has(uuid)) {
                if (excluded.size >= cards.length / 2) {
                    let rand = [];
                    for (let i = 0; i < cards.length; i++) {
                        let candidateUuid = cards[i].id;
                        if (!excluded.has(candidateUuid)) {
                            rand.push(candidateUuid);
                        }
                    }
                    if (rand.length === 0) {
                        res.status(500).send({message: NO_CARD_REMAINING_MESSAGE});
                        return;
                    }
                    uuid = rand[randomInt(0, rand.length)];
                } else {
                    while (excluded.has(uuid)) {
                        uuid = cards[randomInt(0, cards.length)].id;
                    }
                }
            }
            res.json(cards[uuidToIndex[uuid]]);
        }).catch((err) => {
            res.json({status: 401});
        });
    }).catch(() => {
        res.status(401).send({message: AUTH_FAILED_MESSAGE});
    });
});

preprocess().then(() => {
    const httpsServer = https.createServer(credentials, app);
    httpsServer.listen(443, () => console.log('listening'));
});