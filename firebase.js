import { initializeApp } from
  "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";

import {
  getFirestore,
  doc,
  setDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";


const firebaseConfig = {
  apiKey: "AIzaSyCOX6A5veapHTN_7ma8qgP7-kstDIIV-y8",
  authDomain: "cm6-line-editor.firebaseapp.com",
  projectId: "cm6-line-editor",
  storageBucket: "cm6-line-editor.firebasestorage.app",
  messagingSenderId: "1016509709083",
  appId: "1:1016509709083:web:bbe88605f3d9dbfa4d31be",
  measurementId: "G-7YQNKGV5XG"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export {
  db,
  doc,
  setDoc,
  updateDoc
};