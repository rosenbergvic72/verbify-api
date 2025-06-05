import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

let quickQuestions = {};
// Загружаем данные из файла при запуске
async function loadQuestions() {
  try {
    const data = await fs.readFile('./quickQuestions.json', 'utf8');
    quickQuestions = JSON.parse(data);
    console.log('Быстрые вопросы загружены');
  } catch (e) {
    console.error('Ошибка загрузки quickQuestions:', e);
  }
}
await loadQuestions();

app.get('/api/quick-questions', (req, res) => {
  const lang = req.query.lang || 'en';
  res.json(quickQuestions[lang] || quickQuestions['en'] || []);
});

app.get('/', (req, res) => {
  res.send('Verbify API is running!');
});

app.listen(PORT, () => {
  console.log(`Server started at http://localhost:${PORT}`);
});
