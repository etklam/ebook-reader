import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles/tokens.css';
import './styles/app.css';
import './styles/reader.css';

createRoot(document.getElementById('root')!).render(<App />);
