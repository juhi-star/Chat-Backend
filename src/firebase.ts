import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { config } from './config';

initializeApp(
  config.usingEmulator
    ? { projectId: config.firebaseProjectId }
    : { projectId: config.firebaseProjectId, credential: applicationDefault() },
);

export const firestore = getFirestore();
