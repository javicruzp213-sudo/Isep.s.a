importScripts(
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js'
);

importScripts(
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js'
);

firebase.initializeApp({
  apiKey: "AIzaSyBQ3ojcGtxCkd8zWTFz3Z-bXZux4kU8VrU",
  authDomain: "isep-e7efe.firebaseapp.com",
  projectId: "isep-e7efe",
  storageBucket: "isep-e7efe.firebasestorage.app",
  messagingSenderId: "838801875419",
  appId: "1:838801875419:web:abef6e9fb2f0f7bcd907fe"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log("Notificación recibida:", payload);

  // Firebase muestra automáticamente las
  // notificaciones que incluyen un payload notification.
  // Este manejador se reserva para datos personalizados.
});
