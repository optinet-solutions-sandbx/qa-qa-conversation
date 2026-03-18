import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import analyzeHandler from './api/analyze.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname)); // Serves index.html, css, js

app.post('/api/analyze', analyzeHandler);

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});