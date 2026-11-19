// Maker recognizes this exported Express instance as a framework entry and
// generates routes for both /blog and /blog/*. Do not export onRequest: its
// Response adapter collapses repeated Set-Cookie headers into one value.
import express from 'express';
import { handleRequest } from './proxy.js';

const app = express();
app.disable('x-powered-by');
// Keep request bytes untouched: WordPress handles forms and multipart uploads.
app.use(handleRequest);

export default app;
