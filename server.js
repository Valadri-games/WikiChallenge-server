import http from "http";
import mysql from "mysql";

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

dbConnection.connect(function(err) {
    if(err) throw err;
    console.log("Database connected !");
});

// Create an http server
const server = http.createServer(() => {
    response.end('Server is running');
});
server.listen(process.env.SERVER_PORT);

const io = new Server(server, {
    cors: {
        origin: "*",
    }
});

io.on('connection', (socket) => {
    console.log('New user connection');

    socket.on("getStartPage", (data) => {
        let randomInt = Math.floor(Math.random() * (10554407 - 45204 + 1)) + 45204; // Update if entries are added to the database, 19.09.2023

        let sql = `SELECT ID, title FROM pagetitles WHERE (interest BETWEEN ${data.interestLow} AND ${data.interestHigh}) AND (difficulty BETWEEN ${data.difficultyLow} AND ${data.difficultyHigh}) AND ID >= ${randomInt} LIMIT 1`;
        dbConnection.query(sql, function (err, result) {
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
        dbConnection.query(sql, function (err, result) {
            if(err) throw err;

            socket.emit("getEndPage", {
                id: result[0].ID,
                title: result[0].title,
            });
        });
    });

    socket.on("getEndPage", (data) => {
        
    });
});

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