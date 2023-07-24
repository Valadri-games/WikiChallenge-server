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

const dbPool = mysql.createPool({
    connectionLimit : 50,

    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database : 'wikichallenge',

    multipleStatements: true,
});

dbPool.query("SET GLOBAL sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''))", async (err, result) => {
    if(err) console.log(err);
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

        let passwordHash = await hashPass(data.password);
        if(!passwordHash) return emitUnsuccessful(socket, "createAccount", 0x3);

        let joindate = Date.now();

        let sql = mysql.format(`
            INSERT INTO users (name, password, avatarid, joindate, lastlogin) 
            VALUES (?, ?, ?, ?, ?)
        `, 
        [data.name, passwordHash, data.avatarid, joindate, joindate]);

        dbPool.query(sql, async (err, result) => {
            if(err) return catchDbError(err, socket, "createAccount");

            let userID = result.insertId;

            let sessionid = await saveSessionId(userID);
            if(!sessionid) return emitUnsuccessful(socket, "createAccount", 0x3);

            socket.emit("createAccount", {
                succes: true,
                sessionid: sessionid,
            });
        });
    });

    socket.on("login", async (data) => {
        let sql = mysql.format(`SELECT * FROM users WHERE name = ?`, [data.name]);
        
        dbPool.query(sql, async (err, result) => {
            if(err) return catchDbError(err, socket, "login");

            if(result.length == 0) return emitUnsuccessful(socket, "login", 0x121);
            if(!await verifyPass(data.password, result[0].password)) return emitUnsuccessful(socket, "login", 0x121);

            let sessionid = await saveSessionId(result[0].ID);
            if(!sessionid) return emitUnsuccessful(socket, "login", 0x3);

            result[0].sessionid = sessionid;
            let sortedData = sortUserData(result[0]);

            let allUserData = await getAllUserData(sortedData);
            if(!allUserData) return emitUnsuccessful(socket, "login", 0x3);

            let userData = await updateUserData(allUserData);
            if(!userData) return emitUnsuccessful(socket, "login", 0x3);

            socket.emit("login", {
                succes: true,
                sessionid: sessionid,
                data: userData,
            });
        });
    });

    socket.on("sessionlogin", async (data) => {
        let sql = mysql.format(`
            SELECT
                userssession.userid, 
                userssession.date, 
                userssession.sessionid, 
                users.* 
            FROM userssession 
            INNER JOIN users 
            ON userssession.userid = users.ID 
            WHERE userssession.sessionid = ?`, 
        [data.sessionid]);
        
        dbPool.getConnection((err, connection) => {
            connection.query(sql, async (err, result) => {
                if(err) return catchDbError(err, socket, "sessionlogin", connection);
    
                if(result.length == 0) return emitUnsuccessful(socket, "sessionlogin", 0x122);
    
                // Delete session id after 2 month
                if(result[0].date > Date.now() + 1000 * 60 * 60 * 24 * 62) { // 2 months
                    let sql = mysql.format(`DELETE FROM userssession WHERE sessionid = ?`, [result[0].sessionid]);
                    
                    return connection.query(sql, async (err, result) => {
                        connection.release();

                        if(err) return catchDbError(err, socket, "sessionlogin");
                        return emitUnsuccessful(socket, "sessionlogin", 0x123);
                    });
                } else connection.release();
    
                let sortedData = sortUserData(result[0]);
    
                let allUserData = await getAllUserData(sortedData);
                if(!allUserData) return emitUnsuccessful(socket, "sessionlogin", 0x3);
    
                let userData = await updateUserData(allUserData);
                if(!userData) return emitUnsuccessful(socket, "sessionlogin", 0x3);
    
                socket.emit("sessionlogin", {
                    succes: true,
                    data: userData,
                });
            });
        });
    });

    socket.on("saveUserData", async (data) => {
        saveUserData(data, socket, "saveUserData");
    });

    socket.on("registergame", async (data) => {
        let sql = mysql.format(`
            INSERT INTO gamesplayed (userid, pagefrom, pageto, gamemode, score, totaltime, date, pathlength) 
            SELECT 
                userid, 
                ?, ?, ?, ?, ?, ?, ?
            FROM userssession WHERE sessionid = ?;

            UPDATE users 
            INNER JOIN userssession 
            ON users.ID = userssession.userid 
            SET 
                score = score + ?,
                gameplayed = gameplayed + 1,

                pagesseen = pagesseen + ${data.pathlength} + 1,

                dailychallengeplayed = dailychallengeplayed + ${ data.gamemode == 5 ? 1 : 0 },
                easygame = easygame + ${ data.gamemode == 1 ? 1 : 0 },
                mediumgame = mediumgame + ${ data.gamemode == 2 ? 1 : 0 },
                hardgame = hardgame + ${ data.gamemode == 3 ? 1 : 0 },
                randompagegame = randompagegame + ${ data.gamemode == 4 ? 1 : 0 }
            WHERE userssession.sessionid = ?
        `,
        [data.pagefrom, data.pageto, data.gamemode, data.score, data.totaltime, data.date, data.pathlength, data.sessionid, data.score, data.sessionid]);

        dbPool.query(sql, async (err, result) => {
            if(err) return catchDbError(err, socket, "registergame");
            socket.emit("registergame", { succes: true, });
        });
    });

    socket.on("pathFun", async (data) => {
        let increment = 0;
        if(data.pathFun == 1) increment = -5;
        else if(data.pathFun == 3) increment = 5;

        let sql = mysql.format(`
            UPDATE pagetitles 
            SET interest = (interest + (?)) 
            WHERE title = ?`,
        [increment, data.pagetitle]);

        dbPool.query(sql, async (err, result) => {
            if(err) return catchDbError(err, socket, "pathFun");
        });
    });

    socket.on("dailyChallengeFun", async (data) => {
        let today = Utils.getTodayMidnight();

        let increment = 0;
        if(data.pathFun == 1) increment = -1;
        else if(data.pathFun == 3) increment = 1;

        let sql = mysql.format(`
            UPDATE dailychallenge 
            SET fun = (fun + (?)) 
            WHERE date = ?`,
        [increment, today.getTime()]);

        dbPool.query(sql, async (err, result) => {
            if(err) return catchDbError(err, socket, "dailyChallengeFun");
        });
    });

    socket.on("pathDifficulty", async (data) => {
        let increment = 0;
        if(data.pathDifficulty == 1) increment = -1;
        else if(data.pathDifficulty == 3) increment = 1;

        let sql = mysql.format(`
            UPDATE pagetitles 
            SET difficulty = (interest + (?)) 
            WHERE title = ?`,
        [increment, data.pagetitle]);

        dbPool.query(sql, async (err, result) => {
            if(err) return catchDbError(err, socket, "pathDifficulty");
        });
    });

    socket.on("getDailyChallenge", async (data) => {
        let today = Utils.getTodayMidnight();

        let sql = mysql.format(`SELECT startpage, endpage, difficulty FROM dailychallenge WHERE date = ?`, [today.getTime()]);
    
        dbPool.query(sql, (err, result) => {
            if(err) return catchDbError(err, socket, "getDailyChallenge");

            if(result.length > 0) {
                socket.emit("getDailyChallenge", {
                    startpage: result[0].startpage,
                    endpage: result[0].endpage,
                    difficulty: result[0].difficulty,
                });
            } else emitUnsuccessful(socket, "getDailyChallenge", 0x21);
        });
    });

    socket.on("getDailyChallengeLeaderboard", async (data) => {
        let sql = mysql.format(`SELECT userid FROM userssession WHERE sessionid = ?`, [data.sessionid]);
    
        dbPool.getConnection((err, connection) => {
            connection.query(sql, (err, result) => {
                if(err) return catchDbError(err, socket, "getDailyChallengeLeaderboard", connection);
    
                let todayTime = Utils.getTodayMidnight().getTime();
                let sql = mysql.format(`
                    SELECT gp.score, u.name, u.avatarid
                    FROM gamesplayed as gp
                    INNER JOIN users as u
                    ON u.ID = gp.userid
                    WHERE gp.date >= ?
                    AND gp.gamemode = 5
                    AND u.name != 'dev'
                    ORDER BY gp.score
                    DESC
                    LIMIT 20;
    
                    SELECT gp.pathlength, u.name, u.avatarid
                    FROM gamesplayed as gp
                    INNER JOIN users as u
                    ON u.ID = gp.userid
                    WHERE gp.date >= ?
                    AND gp.gamemode = 5
                    AND u.name != 'dev'
                    ORDER BY gp.pathlength
                    ASC
                    LIMIT 20;
    
                    SELECT gp.totaltime, u.name, u.avatarid
                    FROM gamesplayed as gp
                    INNER JOIN users as u
                    ON u.ID = gp.userid
                    WHERE gp.date >= ?
                    AND gp.gamemode = 5
                    AND u.name != 'dev'
                    ORDER BY gp.totaltime
                    ASC
                    LIMIT 20;
                `,
                [todayTime, todayTime, todayTime]);
    
                let userid = result.length > 0 ? result[0].userid : 0;
                if(userid != 0) {
                    sql += mysql.format(`
                        SELECT
                            COUNT(ID) as userrank,
                            COALESCE(userinfos.score, 0) as userscore
                        FROM 
                            gamesplayed, 
                            (SELECT score FROM gamesplayed WHERE gamemode = 5 AND date >= ? AND userid = ?) as userinfos
                        WHERE date >= ?
                        AND gamemode = 5
                        AND userid != 30
                        AND gamesplayed.score >= userinfos.score;
    
                        SELECT
                            COUNT(ID) as userrank,
                            COALESCE(userinfos.pathlength, 0) as userpathlength
                        FROM 
                            gamesplayed,
                            (SELECT pathlength FROM gamesplayed WHERE gamemode = 5 AND date >= ? AND userid = ?) as userinfos
                        WHERE date >= ?
                        AND gamemode = 5
                        AND userid != 30
                        AND gamesplayed.pathlength <= userinfos.pathlength;
    
                        SELECT
                            COUNT(ID) as userrank,
                            COALESCE(userinfos.totaltime, 0) as usertotaltime
                        FROM 
                            gamesplayed,
                            (SELECT totaltime FROM gamesplayed WHERE gamemode = 5 AND date >= ? AND userid = ?) as userinfos
                        WHERE date >= ?
                        AND gamemode = 5
                        AND userid != 30
                        AND gamesplayed.totaltime <= userinfos.totaltime;
                    `,
                    [todayTime, userid, todayTime, todayTime, userid, todayTime, todayTime, userid, todayTime]);
                }
    
                connection.query(sql, (err, result) => {
                    connection.release();

                    if(err) return catchDbError(err, socket, "getDailyChallengeLeaderboard");
    
                    socket.emit("getDailyChallengeLeaderboard", {
                        succes: true,
                        result: result,
                    });
                });
            });
        });
    });

    socket.on("getGeneralLeaderboard", async (data) => {
        let sql = mysql.format(`SELECT userid FROM userssession WHERE sessionid = ?`, [data.sessionid]);
    
        dbPool.getConnection((err, connection) => {
            connection.query(sql, (err, result) => {
                if(err) return catchDbError(err, socket, "getGeneralLeaderboard", connection);
    
                if(data.sessionid == "") result.push({ // If user load leaderboard without account
                    userid: 30,
                });
    
                let sql = `
                    SELECT score, name, avatarid
                    FROM users
                    WHERE name != 'dev'
                    ORDER BY score
                    DESC
                    LIMIT 100;
    
                    SELECT streakdays, name, avatarid
                    FROM users
                    WHERE name != 'dev'
                    ORDER BY streakdays
                    DESC
                    LIMIT 100;
    
                    SELECT gameplayed, name, avatarid
                    FROM users
                    WHERE name != 'dev'
                    ORDER BY gameplayed
                    DESC
                    LIMIT 100;
    
                    SELECT pagesseen, name, avatarid
                    FROM users
                    WHERE name != 'dev'
                    ORDER BY pagesseen
                    DESC
                    LIMIT 100;
    
                    SELECT
                        COUNT(ID) as userrank,
                        COALESCE(userinfos.score, 0) as userscore
                    FROM 
                        users,
                        (SELECT score FROM users WHERE ID = ${result[0].userid}) as userinfos
                    WHERE name != 'dev'
                    AND users.score >= userinfos.score;
    
                    SELECT
                        COUNT(ID) as userrank,
                        COALESCE(userinfos.streakdays, 0) as userstreakdays
                    FROM 
                        users,
                        (SELECT streakdays FROM users WHERE ID = ${result[0].userid}) as userinfos
                    WHERE name != 'dev'
                    AND users.streakdays >= userinfos.streakdays;
    
                    SELECT
                        COUNT(ID) as userrank,
                        COALESCE(userinfos.gameplayed, 0) as usergameplayed
                    FROM 
                        users,
                        (SELECT gameplayed FROM users WHERE ID = ${result[0].userid}) as userinfos
                    WHERE name != 'dev'
                    AND users.gameplayed >= userinfos.gameplayed;
    
                    SELECT
                        COUNT(ID) as userrank,
                        COALESCE(userinfos.pagesseen, 0) as userpagesseen
                    FROM 
                        users,
                        (SELECT pagesseen FROM users WHERE ID = ${result[0].userid}) as userinfos
                    WHERE name != 'dev'
                    AND users.pagesseen >= userinfos.pagesseen;
                `;
    
                // User id 30 == dev account
        
                connection.query(sql, (err, result) => {
                    connection.release();
                    if(err) return catchDbError(err, socket, "getGeneralLeaderboard");
    
                    socket.emit("getGeneralLeaderboard", {
                        succes: true,
                        result: result,
                    });
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

function catchDbError(err, socket = false, keyword = false, connection = false) {
    console.error(err);

    if(connection) connection.release();
    if(socket && keyword) emitUnsuccessful(socket, keyword, 0x2); 
}

function checkUsernameAvailability(name) {
    return new Promise((resolve) => {
        let sql = mysql.format(`SELECT ID from users WHERE name = ?`, [name]);

        dbPool.query(sql, (err, result) => {
            if(err) return resolve(false);
            resolve((result.length > 0 ? false : true));
        });
    });
}

function saveSessionId(userID) {
    return new Promise(async (resolve) => {
        let date = Date.now();
        let random = Utils.randomInt(1, 10000);

        let sessionid = await hashPass("" + userID + date + random);
        let sql = mysql.format(`INSERT INTO userssession (userid, sessionid, date) VALUES (?, ?, ?)`, [userID, sessionid, date]);

        dbPool.query(sql, async (err, result) => {
            if(err) return resolve(false);
            resolve(sessionid);
        });
    });
}

function saveUserData(userData) {
    return new Promise(async (resolve) => {
        if(userData.lastlogin) await performExtendedSave(userData); 

        let sql = mysql.format(`
            UPDATE users 
            INNER JOIN userssession 
            ON users.ID = userssession.userid 
            SET users.avatarid = ?
            WHERE userssession.sessionid = ?
        `,
        [userData.avatarid, userData.sessionid]);

        dbPool.query(sql, async (err, result) => {
            if(err) return resolve(false);
            resolve(true);
        });
    });
}

function performExtendedSave(userData) {
    return new Promise(async (resolve) => {
        let sql = mysql.format(`
            UPDATE users 
            INNER JOIN userssession 
            ON users.ID = userssession.userid 
            SET users.lastlogin = ?, 
                users.streakdays = ?, 

                users.daylichallengepodium = ? 
            WHERE userssession.sessionid = ?
        `,
        [userData.lastlogin, userData.streakdays, userData.daylichallengepodium, userData.sessionid]);

        dbPool.query(sql, async (err, result) => {
            if(err) return resolve(false);
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

async function getAllUserData(userData) {
    return new Promise(async (resolve) => {
        let today = Utils.getTodayMidnight().getTime();

        let sql = mysql.format(`
            SELECT 
                COALESCE(SUM(score), 0) as totalscore, 
                COUNT(gamesplayed.ID) as totalgames
            FROM gamesplayed 
            INNER JOIN userssession 
            ON userssession.userid = gamesplayed.userid 
            WHERE userssession.sessionid = ?
            AND gamesplayed.date >= ?;

            SELECT gamesplayed.score
            FROM gamesplayed 
            INNER JOIN userssession 
            ON userssession.userid = gamesplayed.userid 
            WHERE userssession.sessionid = ?
            AND gamesplayed.date >= ? 
            AND gamesplayed.gamemode = 5;
        `,
        [userData.sessionid, today, userData.sessionid, today]);

        dbPool.query(sql, async (err, result) => {
            if(err) return resolve(false);

            userData.todaygamecount = result[0][0].totalgames;
            userData.todayscorecount = result[0][0].totalscore;
            
            if(result[1].length > 0) {
                userData.dailychallengedone = true;
                userData.dailychallengescore = result[1][0].score;
            }
            else {
                userData.dailychallengedone = false;
                userData.dailychallengescore = 0;
            }

            resolve(userData);
        });
    });
}

async function updateUserData(userData) {
    // Update day streak count
    if(Utils.isDateYesterday(userData.lastlogin)) userData.streakdays += 1;

    userData.lastlogin = Date.now();

    let result = await saveUserData(userData);

    if(result) return userData;
    else return false;
}

async function getRandomPage(data) {
    return new Promise(async (resolve) => {
        // Better accuracy version of random page title generator
        for(let i = 0; i < 300; i++) { // Higher max loop count will result in higher maximum response time
            let promiseResult = await new Promise((resolveInside) => {
                let randomInt = Math.floor(Math.random() * (10554407 - 45204 + 1)) + 45204; // Update if entries are added to the database, 19.09.2023
                let randomIntMax = randomInt + 40; // Higher ap will result in less accuracy but better speed

                let sql = mysql.format(`
                    SELECT 
                        ID, 
                        title 
                    FROM pagetitles 
                    WHERE 
                        (interest BETWEEN ? AND ?) 
                    AND 
                        (difficulty BETWEEN ? AND ? ) 
                    AND 
                        (ID BETWEEN ? AND ?) 
                    LIMIT 1`,
                [data.gamesettings.interestLow, data.gamesettings.interestHigh, data.gamesettings.difficultyLow, data.gamesettings.difficultyHigh, randomInt, randomIntMax]);
                
                dbPool.query(sql, (err, result) => {
                    if(err) return resolve(false);
                    resolveInside(result);
                });
            });

            if(promiseResult.length > 0 && promiseResult[0].title != data.otherpage) {
                promiseResult[0].lessaccurate = false;
                return resolve(promiseResult[0]);
            }
        }

        // To avoid infinite while loop this will select a less random page after too many attemps of the better algorithm

        let randomInt = Math.floor(Math.random() * (10554407 - 45204 + 1)) + 45204; // Update if entries are added to the database, 19.09.2023
        let sql = mysql.format(`
            SELECT 
                ID, 
                title 
            FROM pagetitles 
            WHERE 
                (interest BETWEEN ? AND ?) 
            AND 
                (difficulty BETWEEN ? AND ?) 
            AND ID >= ?
            LIMIT 1
        `, [data.gamesettings.interestLow, data.gamesettings.interestHigh, data.gamesettings.difficultyLo, data.gamesettings.difficultyHigh, randomInt]);
        
        
        dbPool.query(sql, (err, result) => {
            if(err) return resolve(false);

            if(result.length == 0 || result[0].title == data.otherpage) resolve(false);
            else resolve({
                id: result[0].ID,
                title: result[0].title,
                lessaccurate: true,
            });
        });
    });
}

function hashPass(password) {
    return new Promise((resolve) => {
        bcrypt.genSalt(10, (err, salt) => {
            if(err) return resolve(false)

            bcrypt.hash(password, salt, (err, hash) => {
                if(err) return resolve(false);
                resolve(hash);
            });
        })
    });
}

function verifyPass(password, hash) {
    return new Promise((resolve) => {
        bcrypt.compare(password, hash, (err, result) => {
            if(err) return resolve(false);
            resolve(result);
        });
    });
}

class Utils {
    static isDateYesterday(dateTimestamp) {
        let yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
    
        let providedDate = new Date(dateTimestamp);
    
        return (providedDate.getDate() == yesterday.getDate() && providedDate.getMonth() == yesterday.getMonth() && providedDate.getFullYear() == yesterday.getFullYear());
    }
    
    static getTodayMidnight() {
        let date = new Date();
        let timezoneOffset = -date.getTimezoneOffset() / 60;
    
        date.setHours(timezoneOffset, 0, 0, 0);
    
        return date;
    }
    
    static randomInt(min, max) {
        return Math.trunc(Math.random() * (max - min + 1)) + min;
    }
}

/* Error code

0x1: User provided information
    0x11: Signin step
        0x111: Username already taken

    0x12: Login step
        0x121: Wrong name or password
        0x122: Invalide session id
        0x123: Session id too old

0x2: Daily challenge
    0x21: No daily challenge

0x3: Internal server error

*/