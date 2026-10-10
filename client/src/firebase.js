import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported } from "firebase/analytics";

const firebaseConfig = {
  apiKey: "AIzaSyApuwYEz8WnzzeE0zOTZ-PIqLpx_5v3JFs",
  authDomain: "videodownloader-37389.firebaseapp.com",
  projectId: "videodownloader-37389",
  storageBucket: "videodownloader-37389.firebasestorage.app",
  messagingSenderId: "783903715973",
  appId: "1:783903715973:web:e69f40799e7a799b4f2fec",
  measurementId: "G-GQK73L4TEK"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Analytics if supported in environment
let analytics = null;
if (typeof window !== "undefined") {
  isSupported().then((supported) => {
    if (supported) {
      analytics = getAnalytics(app);
    }
  });
}

export { app, analytics };
