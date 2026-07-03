import React from 'react';
import ReactDOM from 'react-dom/client';
import './mc-bridge'; // installs window.mc backed by Tauri (Rust) commands
import App from './App';
import { I18nProvider } from './i18n';
import './index.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
