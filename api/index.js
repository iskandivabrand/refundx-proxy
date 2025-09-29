import 'dotenv/config';
import express from 'express';
import serverless from 'serverless-http';
import { verifyProxy } from '../verifyProxy.js';
import app from '../server.js';

export default serverless(app);

