
import dotenv from "dotenv";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

dotenv.config();

const firebaseApp =
  getApps()[0] ??
  initializeApp({
    credential: applicationDefault(),
  });

export const firestore = getFirestore(firebaseApp);
