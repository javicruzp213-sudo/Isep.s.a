importScripts(
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js'
);

importScripts(
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js'
);

firebase.initializeApp({
  apiKey: "TU_FIREBASE_API_KEY",
  authDomain: "TU_PROYECTO.firebaseapp.com",
  projectId: "TU_PROJECT_ID",
  storageBucket: "TU_PROYECTO.appspot.com",
  messagingSenderId: "TU_MESSAGING_SENDER_ID",
  appId: "TU_FIREBASE_APP_ID"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log("Notificación recibida:", payload);

  // Firebase puede mostrar automáticamente las
  // notificaciones que incluyen un payload notification.
  // Este manejador se reserva para datos personalizados.
});
