import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { AuthGate } from './components/auth/AuthGate';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);
