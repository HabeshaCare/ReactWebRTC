const fs = require("fs");
// const https = require("https");
const http = require("http");
const express = require("express");
const app = express();
const socketio = require("socket.io");
const jwt = require("socketio-jwt");

require("dotenv").config();

const isProduction = process.env.IS_PRODUCTION === "true";
const frontendUrl = process.env.FRONTEND_URL;
const corsOrigin =
  isProduction && frontendUrl ? frontendUrl : "http://localhost:5173";

const UPDATE_INTERVAL_IN_MILLISECONDS = 1000;

//we need a key and cert to run https
//we generated them with mkcert
// $ mkcert create-ca
// $ mkcert create-cert
// const key = fs.readFileSync("cert.key");
// const cert = fs.readFileSync("cert.crt");

//we changed our express setup so we can use https
//pass the key and cert to createServer on https

// const expressServer = https.createServer({ key, cert }, app);

const expressServer = http.createServer(app);
//create our socket.io server... it will listen to our express port
const io = socketio(expressServer, {
  cors: {
    origin: [
      corsOrigin, //if using a phone or another computer
    ],
    methods: ["GET", "POST"],
  },
});

io.use(
  jwt.authorize({
    secret: process.env.SECRET_KEY,
    handshake: true,
  })
);
expressServer.listen(8181, () => console.log("Server running on port 8181"));

//offers will contain {}
const offers = [
  // offererUserName
  // offer
  // offerIceCandidates
  // answererUserName
  // answer
  // answererIceCandidates
];
const connectedSockets = [
  //socketId
  //username
  //role
  //intervalId
  //connectedTime
  //remainingTime
  //connectionId
];

io.on("connection", (socket) => {
  console.log("Found jwt token: ", socket.decoded_token);
  const userName = socket.decoded_token.username;
  const role = socket.decoded_token.role;
  const connectionId = socket.handshake.query.connectionId;

  const { userAlreadyConnected, offerObj } = connectedUserOffer(connectionId);
  const didIOffer = userAlreadyConnected == null ? true : false; // If there is an already connected user, then the current user is the answerer

  connectedSockets.push({
    socketId: socket.id,
    userName,
    role: role,
    intervalId: null,
    connectedTime: 0,
    remainingTime: null,
    connectionId,
  });

  console.log("User with name: ", userName);
  socket.emit("connected", { didIOffer, offerObj });

  socket.on("sessionStarted", (timeToConnect) => {
    const userName = socket.decoded_token.username;
    console.log("Session started for user: ", userName);
    console.log("Received time to connect: ", timeToConnect);

    const connectedUsername = connectedTo(userName);

    console.log("Connected to: ", connectedUsername);
    const answeringUser = connectedSockets.find(
      (user) => user.userName === userName
    );
    const callingUser = connectedSockets.find(
      (user) => user.userName === connectedUsername
    );

    console.log("Answering user info: ", answeringUser);
    console.log("Calling user info: ", callingUser);

    socket.to(answeringUser.socketId).emit("notification", "Session started");

    const intervalId = setInterval(() => {
      const userSessionsToUpdate = [answeringUser, callingUser];
      console.log("Interval running...");
      if (answeringUser && callingUser) {
        console.log("User sessions to update: ", userSessionsToUpdate);
        userSessionsToUpdate.forEach((user) => {
          user.connectedTime += UPDATE_INTERVAL_IN_MILLISECONDS;

          if (user.role === "Patient") {
            if (!user.remainingTime) user.remainingTime = timeToConnect;
            user.remainingTime -= UPDATE_INTERVAL_IN_MILLISECONDS;
            console.log(
              "Updating Patient remaining time: ",
              user.remainingTime
            );

            if (user.remainingTime <= 10) {
              io.to(answeringUser.socketId).emit(
                "notification",
                "User time limit exceeded"
              );
              io.to(callingUser.socketId).emit(
                "notification",
                "User time limit exceeded"
              );
            }

            if (user.remainingTime <= 0) {
              io.to(answeringUser.socketId).emit(
                "notification",
                "User time limit exceeded"
              );
              io.to(callingUser.socketId).emit(
                "notification",
                "User time limit exceeded"
              );

              io.to(answeringUser.socketId).emit("sessionEnded");
              io.to(callingUser.socketId).emit("sessionEnded");

              console.log("Disconnecting user due to time limit exceeded");
            }
          }
        });
      }
    }, UPDATE_INTERVAL_IN_MILLISECONDS);

    answeringUser.intervalId = intervalId;
    callingUser.intervalId = intervalId;
  });
  //a new client has joined. If there are any offers available,
  //emit them out
  if (offers.length) {
    socket.emit("availableOffers", offers);
  }

  socket.on("newOffer", ({ newOffer, connectionId }) => {
    offers.push({
      offererUserName: userName,
      offer: newOffer,
      offerIceCandidates: [],
      answererUserName: null,
      answer: null,
      answererIceCandidates: [],
    });
    // console.log(newOffer.sdp.slice(50))
    //send out to all connected sockets EXCEPT the caller

    socket.broadcast.emit("newOfferAwaiting", offers.slice(-1));
  });

  socket.on("newAnswer", (offerObj, ackFunction) => {
    console.log(offerObj);
    //emit this answer (offerObj) back to CLIENT1
    //in order to do that, we need CLIENT1's socketid
    const socketToAnswer = connectedSockets.find(
      (s) => s.userName === offerObj.offererUserName
    );
    if (!socketToAnswer) {
      console.log("No matching socket");
      return;
    }
    //we found the matching socket, so we can emit to it!
    const socketIdToAnswer = socketToAnswer.socketId;
    //we find the offer to update so we can emit it
    const offerToUpdate = offers.find(
      (o) => o.offererUserName === offerObj.offererUserName
    );
    if (!offerToUpdate) {
      console.log("No OfferToUpdate");
      return;
    }
    //send back to the answerer all the iceCandidates we have already collected
    ackFunction(offerToUpdate.offerIceCandidates);
    offerToUpdate.answer = offerObj.answer;
    offerToUpdate.answererUserName = userName;
    //socket has a .to() which allows emitting to a "room"
    //every socket has it's own room
    socket.to(socketIdToAnswer).emit("answerResponse", offerToUpdate);
  });

  socket.on("sendIceCandidateToSignalingServer", (iceCandidateObj) => {
    const { didIOffer, iceUserName, iceCandidate } = iceCandidateObj;
    // console.log(iceCandidate);
    if (didIOffer) {
      //this ice is coming from the offerer. Send to the answerer
      const offerInOffers = offers.find(
        (o) => o.offererUserName === iceUserName
      );
      if (offerInOffers) {
        offerInOffers.offerIceCandidates.push(iceCandidate);
        // 1. When the answerer answers, all existing ice candidates are sent
        // 2. Any candidates that come in after the offer has been answered, will be passed through
        if (offerInOffers.answererUserName) {
          //pass it through to the other socket
          const socketToSendTo = connectedSockets.find(
            (s) => s.userName === offerInOffers.answererUserName
          );
          if (socketToSendTo) {
            socket
              .to(socketToSendTo.socketId)
              .emit("receivedIceCandidateFromServer", iceCandidate);
          } else {
            console.log("Ice candidate received but could not find answer");
          }
        }
      }
    } else {
      //this ice is coming from the answerer. Send to the offerer
      //pass it through to the other socket
      const offerInOffers = offers.find(
        (o) => o.answererUserName === iceUserName
      );

      const socketToSendTo = connectedSockets.find(
        (s) => s.userName === offerInOffers?.offererUserName
      );
      if (socketToSendTo) {
        socket
          .to(socketToSendTo.socketId)
          .emit("receivedIceCandidateFromServer", iceCandidate);
      } else {
        console.log("Ice candidate received but could not find offerer");
      }
    }
    // console.log(offers)
  });

  socket.on("disconnect", () => {
    console.log("disconnecting socket with id: ", socket.id);

    for (var i = 0; i < connectedSockets.length; i++) {
      var obj = connectedSockets[i];

      if (obj.socketId === socket.id) {
        //TODO: Here you need to make the necessary updates in the dotnet server too.
        if (obj.intervalId) clearInterval(obj.intervalId); // Stopping the interval id
        let userNameToDelete = obj.userName;
        connectedSockets.splice(i, 1);
        for (var j = 0; j < offers.length; j++) {
          var offer = offers[j];
          if (
            offer.offererUserName === userNameToDelete ||
            offer.answererUserName === userNameToDelete
          ) {
            offers.splice(j, 1);
            j--;
          }
        }
        i--;
      }
    }

    console.log("disconnected");
  });
});

const connectedTo = (userName) => {
  //This function takes a userName and returns the other userName connected to it in WebRTC
  let offer = offers.find((o) => o.offererUserName === userName);
  offer = offer ? offer : offers.find((o) => o.answererUserName === userName);
  return offer.offererUserName === userName
    ? offer.answererUserName
    : offer.offererUserName;
};

const connectedUserOffer = (connectionId) => {
  const userAlreadyConnected = connectedSockets.find(
    (user) => user.connectionId === connectionId
  );

  const offerObj = offers.find(
    (offer) => offer.offererUserName === userAlreadyConnected?.userName
  );

  return { userAlreadyConnected, offerObj };
};
