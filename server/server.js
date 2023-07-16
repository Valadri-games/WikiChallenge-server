import http from "http";
import mysql from "mysql";
import bcrypt from "bcrypt";
import fs from "fs";

import { Server } from "socket.io";
import dotenv from 'dotenv';

// Activate dotenv
dotenv.config();

// Features enabled
let featuresEnabled = {
    login: process.env.ENABLE_LOGIN || false,
    signin: process.env.ENABLE_SIGNIN || false,
    account: process.env.ENABLE_ACCOUNT || false,
    dailyChallenge: process.env.ENABLE_DAILYCHALLENGE || false,
    dailyChallengeLeaderboard: process.env.ENABLE_DAILYCHALLENGE_LEADERBOARD || false,
}

// Databse connection config
const dbConnection = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database : 'wikichallenge',
    multipleStatements: true,
});

dbConnection.connect((err) => {
    if(err) throw err;
    console.log("Database connected !");
});

// Create an http server
const server = http.createServer((request, response) => {
    fs.readFile('website/features.html',(err, data) => {
        response.writeHead(200, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET",
            "Content-Length": data.length,
        });

        response.write(data);
        response.end();
    });
});
server.listen(process.env.SERVER_PORT);

// Socket.io server config
const io = new Server(server, {
    cors: {
        origin: "*",
    }
});

io.on('connection', (socket) => {
    console.log('New user connected');

    // Inform about enabled features
    socket.emit("featuresEnabled", featuresEnabled);

    socket.on("getStartPage", async (data) => {
        socket.emit("getStartPage", await getRandomPage(data));
    });

    socket.on("getEndPage", async (data) => {
        socket.emit("getEndPage", await getRandomPage(data));
    });

    socket.on("createAccount", async (data) => {
        // Check if user name already takensd
        let result = await checkUsernameAvailability(data.name);
        if(result != true) return emitUnsuccessful(socket, "createAccount", 0x111);

        let joindate = Date.now();
        let passwordHash = await hashPass(data.password);

        let sql = `
            INSERT INTO users (name, password, avatarid, joindate, lastlogin) 
            VALUES ('${data.name}', '${passwordHash}', ${data.avatarid}, ${joindate}, ${joindate})
        `;

        dbConnection.query(sql, async (err, result) => {
            if(err) catchDbError(err, socket, "createAccount");

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
            if(err) catchDbError(err, socket, "login");

            if(result.length == 0) return emitUnsuccessful(socket, "login", 0x121);

            if(await verifyPass(data.password, result[0].password)) {
                let sessionid = await saveSessionId(result[0].ID);

                result[0].sessionid = sessionid;
                let userData = await updateUserData(await getAllUserData(sortUserData(result[0]), socket, "login"), socket, "login");

                socket.emit("login", {
                    succes: true,
                    sessionid: sessionid,
                    data: userData,
                });
            } else {
                return emitUnsuccessful(socket, "login", 0x121);
            }
        });
    });

    socket.on("sessionlogin", async (data) => {
        let sql = `SELECT userssession.sessionid, userssession.userid, userssession.date, users.* FROM userssession INNER JOIN users ON userssession.userid = users.ID WHERE userssession.sessionid = '${data.sessionid}'`;
        
        dbConnection.query(sql, async (err, result) => {
            if(err) catchDbError(err, socket, "sessionlogin");

            if(result.length == 0) return emitUnsuccessful(socket, "sessionlogin", 0x122);

            // Delete session id after 2 month
            if(result[0].date > Date.now() + 1000 * 60 * 60 * 24 * 62) { // 2 months
                let sql = `DELETE FROM userssession WHERE ${result[0].sessionid}`;
                
                return dbConnection.query(sql, async (err, result) => {
                    if(err) catchDbError(err, socket, "sessionlogin");
                    return emitUnsuccessful(socket, "sessionlogin", 0x123);
                });
            }

            let userData = await updateUserData(await getAllUserData(sortUserData(result[0]), socket, "sessionlogin"), socket, "sessionlogin");

            socket.emit("sessionlogin", {
                succes: true,
                data: userData,
            });

            return true;
        });
    });

    socket.on("saveUserData", async (data) => {
        saveUserData(data, socket, "saveUserData");
    });

    socket.on("registergame", async (data) => {
        let sql = `INSERT INTO gamesplayed (userid, pagefrom, pageto, gamemode, score, totaltime, date, pathlength) SELECT userid, '${data.pagefrom}', '${data.pageto}', ${data.gamemode}, ${data.score}, ${data.totaltime}, ${data.date}, ${data.pathlength} FROM userssession WHERE sessionid = '${data.sessionid}'`;

        dbConnection.query(sql, async (err, result) => {
            if(err) catchDbError(err, socket, "registergame");
        });
    });

    socket.on("pathFun", async (data) => {
        let increment = 0;
        if(data.pathFun == 1) increment = -5;
        else if(data.pathFun == 3) increment = 5;

        let sql = `
            UPDATE pagetitles 
            SET interest = (interest + (${increment})) 
            WHERE title = '${data.pagetitle}'`;

        dbConnection.query(sql, async (err, result) => {
            if(err) catchDbError(err, socket, "pathFun");
        });
    });

    socket.on("dailyChallengeFun", async (data) => {
        let today = getTodayMidnight();

        let increment = 0;
        if(data.pathFun == 1) increment = -1;
        else if(data.pathFun == 3) increment = 1;

        let sql = `
            UPDATE dailychallenge 
            SET fun = (fun + (${increment})) 
            WHERE date = '${today.getTime()}'`;

        dbConnection.query(sql, async (err, result) => {
            if(err) catchDbError(err, socket, "dailyChallengeFun");
        });
    });

    socket.on("pathDifficulty", async (data) => {
        let increment = 0;
        if(data.pathDifficulty == 1) increment = -1;
        else if(data.pathDifficulty == 3) increment = 1;

        let sql = `
            UPDATE pagetitles 
            SET difficulty = (interest + (${increment})) 
            WHERE title = '${data.pagetitle}'`;

        dbConnection.query(sql, async (err, result) => {
            if(err) catchDbError(err, socket, "pathDifficulty");
        });
    });

    socket.on("getDailyChallenge", async (data) => {
        let today = getTodayMidnight();

        let sql = `SELECT startpage, endpage, difficulty FROM dailychallenge WHERE date = ${today.getTime()}`;
    
        dbConnection.query(sql, (err, result) => {
            if(err) catchDbError(err, socket, "getDailyChallenge");

            socket.emit("getDailyChallenge", {
                startpage: result[0].startpage,
                endpage: result[0].endpage,
                difficulty: result[0].difficulty,
            });
        });
    });

    socket.on("getDailyChallengeLeaderboard", async (data) => {
        let sql = `SELECT userid FROM userssession WHERE sessionid = '${data.sessionid}'`;
    
        dbConnection.query(sql, (err, result) => {
            if(err) catchDbError(err, socket, "getDailyChallengeLeaderboard");

            let today = getTodayMidnight();
            let sql = `
                SELECT gp.score, u.name, u.avatarid
                FROM gamesplayed as gp
                INNER JOIN users as u
                ON u.ID = gp.userid
                WHERE gp.date >= ${today.getTime()}
                AND gp.gamemode = 5
                AND u.name != 'dev'
                ORDER BY gp.score
                DESC
                LIMIT 20;

                SELECT gp.pathlength, u.name, u.avatarid
                FROM gamesplayed as gp
                INNER JOIN users as u
                ON u.ID = gp.userid
                WHERE gp.date >= ${today.getTime()}
                AND gp.gamemode = 5
                AND u.name != 'dev'
                ORDER BY gp.pathlength
                ASC
                LIMIT 20;

                SELECT gp.totaltime, u.name, u.avatarid
                FROM gamesplayed as gp
                INNER JOIN users as u
                ON u.ID = gp.userid
                WHERE gp.date >= ${today.getTime()}
                AND gp.gamemode = 5
                AND u.name != 'dev'
                ORDER BY gp.totaltime
                ASC
                LIMIT 20;

                SELECT
                    COUNT(ID) as userRank
                FROM gamesplayed
                WHERE date >= ${today.getTime()}
                AND gamemode = 5
                AND userid != 30
                AND score >= (SELECT score FROM gamesplayed WHERE gamemode = 5 AND date >= ${today.getTime()} AND userid = ${result[0].userid});

                SELECT
                    COUNT(ID) as userRank
                FROM gamesplayed
                WHERE date >= ${today.getTime()}
                AND gamemode = 5
                AND userid != 30
                AND pathlength <= (SELECT pathlength FROM gamesplayed WHERE gamemode = 5 AND date >= ${today.getTime()} AND userid = ${result[0].userid});

                SELECT
                    COUNT(ID) as userRank
                FROM gamesplayed
                WHERE date >= ${today.getTime()}
                AND gamemode = 5
                AND userid != 30
                AND totaltime <= (SELECT totaltime FROM gamesplayed WHERE gamemode = 5 AND date >= ${today.getTime()} AND userid = ${result[0].userid});
            `;

            // User id 30 == dev account
    
            dbConnection.query(sql, (err, result) => {
                if(err) catchDbError(err, socket, "getDailyChallengeLeaderboard");

                socket.emit("getDailyChallengeLeaderboard", {
                    succes: true,
                    result: result,
                });
            });
        });
    });
});

function emitUnsuccessful(socket, keyword, code) {
    socket.emit(keyword, {
        succes: false,
        code: code,
    });
}

function catchDbError(err, socket, keyword) {
    console.error(err);
    emitUnsuccessful(socket, keyword, 0x2);
}

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

function saveUserData(userData, socket, keyword) {
    return new Promise(async (resolve) => {
        if(userData.lastlogin) await performExtendedSave(userData, socket, keyword); 

        let sql = `
            UPDATE users 
            INNER JOIN userssession 
            ON users.ID = userssession.userid 
            SET users.avatarid = ${userData.avatarid}, 
                users.name = '${userData.name}', 

                users.dailychallengeplayed = ${userData.dailychallengeplayed}, 
                users.easygame = ${userData.easygame}, 
                users.mediumgame = ${userData.mediumgame}, 
                users.hardgame = ${userData.hardgame}, 
                users.randompagegame = ${userData.randompagegame}, 

                users.gameplayed = ${userData.gameplayed}, 
                users.score = ${userData.score}, 
                users.pagesseen = ${userData.pagesseen}
            WHERE userssession.sessionid = '${userData.sessionid}'`;

        dbConnection.query(sql, async (err, result) => {
            if(err) catchDbError(err, socket, keyword);

            resolve(true);
        });
    });
}

function performExtendedSave(userData, socket, keyword) {
    return new Promise(async (resolve) => {
        let sql = `
            UPDATE users 
            INNER JOIN userssession 
            ON users.ID = userssession.userid 
            SET users.lastlogin = ${userData.lastlogin}, 
                users.streakdays = '${userData.streakdays}', 

                users.daylichallengepodium = '${userData.daylichallengepodium}' 
            WHERE userssession.sessionid = '${userData.sessionid}'`;

        dbConnection.query(sql, async (err, result) => {
            if(err) catchDbError(err, socket, keyword);

            resolve(true);
        });
    });
}

function sortUserData(data) {
    return {
        sessionid: data.sessionid,

        avatarid: data.avatarid,
        name: data.name,

        joindate: data.joindate,

        dailychallengeplayed: data.dailychallengeplayed,
        easygame: data.easygame,
        mediumgame: data.mediumgame,
        hardgame: data.hardgame,
        randompagegame: data.randompagegame,

        gameplayed: data.gameplayed,
        score: data.score,
        pagesseen: data.pagesseen,
        daylichallengepodium: data.daylichallengepodium,

        streakdays: data.streakdays,
        lastlogin: data.lastlogin,
    };
}

async function getAllUserData(userData, socket, keyword) {
    return new Promise(async (resolve) => {
        let today = getTodayMidnight();

        let sql = `
            SELECT 
                COALESCE(SUM(score), 0) as totalscore, 
                COUNT(gamesplayed.ID) as totalgames 
            FROM gamesplayed 
            INNER JOIN userssession 
            ON userssession.userid = gamesplayed.userid 
            WHERE userssession.sessionid = '${userData.sessionid}' 
            AND gamesplayed.date >= ${today.getTime()};

            SELECT gamesplayed.score
            FROM gamesplayed 
            INNER JOIN userssession 
            ON userssession.userid = gamesplayed.userid 
            WHERE userssession.sessionid = '${userData.sessionid}' 
            AND gamesplayed.date >= ${today.getTime()} 
            AND gamesplayed.gamemode = 5;
        `;

        dbConnection.query(sql, async (err, result) => {
            if(err) catchDbError(err, socket, keyword);

            userData.todaygamecount = result[0][0].totalgames;
            userData.todayscorecount = result[0][0].totalscore;

            userData.dailychallengedone = result[1].length == 1 ? true : false;
            
            if(result[1][0]) userData.dailychallengescore = result[1][0].score;
            else userData.dailychallengescore = 0;

            resolve(userData);
        });
    });
}

async function updateUserData(userData, socket, keyword) {
    // Update day streak count
    if(isDateYesterday(userData.lastlogin)) userData.streakdays += 1;

    userData.lastlogin = Date.now();

    await saveUserData(userData, socket, keyword);
    return userData;
}

function isDateYesterday(dateTimestamp) {
    let yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    let providedDate = new Date(dateTimestamp);

    return (providedDate.getDate() == yesterday.getDate() && providedDate.getMonth() == yesterday.getMonth() && providedDate.getFullYear() == yesterday.getFullYear());
}

function getTodayMidnight() {
    let date = new Date();
    let timezoneOffset = -date.getTimezoneOffset() / 60;

    date.setHours(timezoneOffset, 0, 0, 0);

    return date;
}

async function getRandomPage(data) {
    return new Promise(async (resolve) => {
        // Better accuracy version of random page title generator
        for(let i = 0; i < 200; i++) { // Higher max loop count will result in higher maximum response time
            let promiseResult = await new Promise((resolveInside) => {
                let randomInt = Math.floor(Math.random() * (10554407 - 45204 + 1)) + 45204; // Update if entries are added to the database, 19.09.2023
                let randomIntMax = randomInt + 15; // Higher ap will result in less accuracy but better speed

                let sql = `SELECT ID, title FROM pagetitles WHERE (interest BETWEEN ${data.interestLow} AND ${data.interestHigh}) AND (difficulty BETWEEN ${data.difficultyLow} AND ${data.difficultyHigh}) AND (ID BETWEEN ${randomInt} AND ${randomIntMax}) LIMIT 1`;
                dbConnection.query(sql, (err, result) => {
                    if(err) throw err;
                    resolveInside(result);
                });
            });

            if(promiseResult.length > 0) {
                promiseResult[0].lessaccurate = false;
                
                resolve(promiseResult[0]);
                return;
            }
        }

        // To avoid infinite while loop this will select a less random page after too many attemps of the better algorithm

        let randomInt = Math.floor(Math.random() * (10554407 - 45204 + 1)) + 45204; // Update if entries are added to the database, 19.09.2023
        let sql = `SELECT ID, title FROM pagetitles WHERE (interest BETWEEN ${data.interestLow} AND ${data.interestHigh}) AND (difficulty BETWEEN ${data.difficultyLow} AND ${data.difficultyHigh}) AND ID >= ${randomInt} LIMIT 1`;
        dbConnection.query(sql, (err, result) => {
            if(err) throw err;

            if(result.length == 0) resolve(false);
            else resolve({
                id: result[0].ID,
                title: result[0].title,
                lessaccurate: true,
            });
        });
    });
}

function randomInt(min, max) {
    return Math.trunc(Math.random() * (max - min + 1)) + min;
}

/* Error code

0x1: User provided information
    0x11: Signin step
        0x111: Username already taken

    0x12: Login step
        0x121: Wrong name or password
        0x122: Invalide session id
        0x123: Session id too old

*/

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