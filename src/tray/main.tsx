import React from 'react';
import ReactDOM from 'react-dom/client';
import TrayMenu from './TrayMenu';
import './tray.css';

ReactDOM.createRoot(document.getElementById('tray-root')!).render(
  <React.StrictMode>
    <TrayMenu />
  </React.StrictMode>
);
