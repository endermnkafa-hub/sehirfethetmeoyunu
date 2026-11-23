import { initializeApp, getApps, getApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyCt41SMtrgp0myh6bVzQZom8a6JfDbScQs",
  authDomain: "sehirfethetmeoyunu.firebaseapp.com",
  databaseURL: "https://sehirfethetmeoyunu-default-rtdb.firebaseio.com",
  projectId: "sehirfethetmeoyunu",
  storageBucket: "sehirfethetmeoyunu.firebasestorage.app",
  messagingSenderId: "1028722718331",
  appId: "1:1028722718331:web:504771a33fd33fc6bd94de",
  measurementId: "G-34EGLN1NNY"
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
export const rtdb = getDatabase(app);
