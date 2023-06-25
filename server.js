import http from "http";
import mysql from "mysql";
import bcrypt from "bcrypt";

import { Server } from "socket.io";
import dotenv from 'dotenv';

// Activate dotenv
dotenv.config();

var dbConnection = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database : 'wikichallenge',
});

dbConnection.connect((err) => {
    if(err) throw err;
    console.log("Database connected !");
});

// Create an http server
const server = http.createServer((request, response) => {
    response.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET",
    });
    response.end('Server is running');
});
server.listen(process.env.SERVER_PORT);

const io = new Server(server, {
    cors: {
        origin: "*",
    }
});

io.on('connection', (socket) => {
    console.log('New user connected');

    socket.on("getStartPage", (data) => {
        let randomInt = Math.floor(Math.random() * (10554407 - 45204 + 1)) + 45204; // Update if entries are added to the database, 19.09.2023

        let sql = `SELECT ID, title FROM pagetitles WHERE (interest BETWEEN ${data.interestLow} AND ${data.interestHigh}) AND (difficulty BETWEEN ${data.difficultyLow} AND ${data.difficultyHigh}) AND ID >= ${randomInt} LIMIT 1`;
        dbConnection.query(sql, (err, result) => {
            if(err) throw err;

            socket.emit("getStartPage", {
                id: result[0].ID,
                title: result[0].title,
            });
        });
    });

    socket.on("getEndPage", (data) => {
        let randomInt = Math.floor(Math.random() * (10554407 - 45204 + 1)) + 45204; // Update if entries are added to the database, 19.09.2023

        let sql = `SELECT ID, title FROM pagetitles WHERE (interest BETWEEN ${data.interestLow} AND ${data.interestHigh}) AND (difficulty BETWEEN ${data.difficultyLow} AND ${data.difficultyHigh}) AND ID >= ${randomInt} LIMIT 1`;
        dbConnection.query(sql, (err, result) => {
            if(err) throw err;

            socket.emit("getEndPage", {
                id: result[0].ID,
                title: result[0].title,
            });
        });
    });

    socket.on("createAccount", async (data) => {
        // Check if user name already takensd
        let result = await checkUsernameAvailability(data.name);
        if(result != true) {
            socket.emit("createAccount", {
                succes: false,
                username: true,
            });

            return false;
        }

        let joindate = Date.now();
        let passwordHash = await hashPass(data.password);

        let sql = `INSERT INTO users (name, password, score, avatarid, joindate, gameplayed) VALUES ('${data.name}', '${passwordHash}', 0, ${data.avatarid}, ${joindate}, 0)`;
        dbConnection.query(sql, async (err, result) => {
            if(err) throw err;

            let userID = result.insertId;
            let sessionid = await saveSessionId(userID);

            socket.emit("createAccount", {
                succes: true,
                sessionid: sessionid,
            });
        });
    });

    socket.on("login", async (data) => {
        let sql = `SELECT * FROM users WHERE name = '${data.name}'`;
        dbConnection.query(sql, async (err, result) => {
            if(err) throw err;

            if(result.length == 0) {
                socket.emit("login", {
                    succes: false,
                });

                return false;
            }

            if(await verifyPass(data.password, result[0].password)) {
                let sessionid = await saveSessionId(result[0].ID);
                let userData = sortUserData(result[0]);

                socket.emit("login", {
                    succes: true,
                    sessionid: sessionid,
                    data: userData,
                });
            } else {
                socket.emit("login", {
                    succes: false,
                });

                return false;
            }
        });
    });

    socket.on("sessionlogin", async (data) => {
        let sql = `SELECT userssession.sessionid, userssession.userid, userssession.date, users.* FROM userssession INNER JOIN users ON userssession.userid = users.ID WHERE userssession.sessionid = '${data.sessionId}'`;
        dbConnection.query(sql, async (err, result) => {
            if(err) throw err;

            if(result.length == 0) {
                socket.emit("sessionlogin", {
                    succes: false,
                });

                return false;
            }

            if(result[0].date > Date.now() + 1000 * 60 * 60 * 24 * 62) { // 2 months
                let sql = `DELETE FROM userssession WHERE ${result[0].sessionid}`;
                dbConnection.query(sql, async (err, result) => {
                    if(err) throw err;

                    socket.emit("sessionlogin", {
                        succes: false,
                    });
                });

                return false;
            }

            let userData = sortUserData(result[0]);

            socket.emit("sessionlogin", {
                succes: true,
                data: userData,
            });

            return true;
        });
    });

    socket.on("saveUserData", async (data) => {
        let sql = `UPDATE users INNER JOIN userssession ON users.ID = userssession.userid SET users.avatarid = ${data.avatarID}, users.gameplayed = ${data.gamePlayed}, users.score = ${data.accountScore}, users.name = '${data.name}' WHERE userssession.sessionid = '${data.sessionId}'`;

        dbConnection.query(sql, async (err, result) => {
            if(err) throw err;
        });
    });
});

function hashPass(password) {
    return new Promise((resolve) => {
        bcrypt.genSalt(10, (err, salt) => {
            bcrypt.hash(password, salt, (err, hash) => {
                resolve(hash);
            });
        })
    });
}

function verifyPass(password, hash) {
    return new Promise((resolve) => {
        bcrypt.compare(password, hash, (err, result) => {
            resolve(result);
        });
    });
}

function checkUsernameAvailability(name) {
    return new Promise((resolve) => {
        let sql = `SELECT ID from users WHERE name = '${name}'`;

        dbConnection.query(sql, (err, result) => {
            if(err) throw err;

            if(result.length > 0) resolve(false);
            else resolve(true);
        });
    });
}

function saveSessionId(userID) {
    return new Promise(async (resolve) => {
        let date = Date.now();
        let random = randomInt(1, 10000);

        let sessionid = await hashPass("" + userID + date + random);
        let sql = `INSERT INTO userssession (userid, sessionid, date) VALUES (${userID}, '${sessionid}', ${date})`;

        dbConnection.query(sql, async (err, result) => {
            if(err) throw err;

            resolve(sessionid);
        });
    });
}

function sortUserData(data) {
    return  {
        score: data.score,
        avatarid: data.avatarid,
        gameplayed: data.gameplayed,
        joindate: data.joindate,
        name: data.name,
    };
}

function randomInt(min, max) {
    return Math.trunc(Math.random() * (max - min + 1)) + min;
}

// http.createServer(async (request, response) => {
//     // Check if request method is different than GET
//     if(request.method != "GET") {
//         rejectRequest(`${request.method} from origin ${request.headers.origin} is not allowed for the request.`, response);
//         return false;
//     }

//     //Check if origin is allowed
//     // if(!allowedOrigins.includes(request.headers.origin)) {
//     //     rejectRequest(`Origin ${request.headers.origin} is not allowed for the request.`, response);
//     //     return false;
//     // }

//     //Check if if url is valid
//     let requestUrl;
//     try {
//         requestUrl = new URL("https://wikiservver.valentin-lelievre.com" + request.url);
//     } catch(error) {
//         rejectRequest("Url is not valid.", response);
//         return false;
//     }

//     // Check if requested url params are present
//     let requestType = requestUrl.searchParams.get("type");
//     if(requestAction == null) {
//         rejectRequest("Request type is not defined.", response);
//         return false;
//     }

 //     let requestAction = requestUrl.searchParams.get("action");
//     if(requestAction == null) {
//         rejectRequest("Request type is not defined.", response);
//         return false;
//     }
    
//     // let requestUserId = requestUrl.searchParams.get("id");
//     // if(requestUserId == null) {
//     //     response.writeHead(200, {
//     //         "Access-Control-Allow-Origin": request.headers.origin,
//     //     });
//     //     response.end("User id is not defined.");
//     //     return false;
//     // }

//     // let requestUserPassword = requestUrl.searchParams.get("password");
//     // if(requestUserPassword == null) {
//     //     response.writeHead(200, {
//     //         "Access-Control-Allow-Origin": request.headers.origin,
//     //     });
//     //     response.end("User password is not defined.");
//     //     return false;
//     // }

//     let result = "Hello World";

//     response.writeHead(200, {
//         //"Access-Control-Allow-Origin": request.headers.origin,
//     });
//     response.end(JSON.stringify(result));
// }).listen(process.env.SERVER_PORT);

// function rejectRequest(code, response) {
//     response.writeHead(200, {
//         "Access-Control-Allow-Origin": "*",
//     });
//     response.end(code);
// }