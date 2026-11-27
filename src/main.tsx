import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { installApiAuthFetch } from './services/apiAuth';

// 必須在任何元件發出請求之前安裝
installApiAuthFetch();

createRoot(document.getElementById('root')!).render(<App />);
