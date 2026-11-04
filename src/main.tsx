// Interface fonts are bundled from npm, so the single-file claude.ai build renders Geist with no network
// (the build inlines them); the customer's content fonts stay on Google Fonts (index.html).
import '@fontsource-variable/geist/wght.css'; // 'Geist Variable', 100–900, normal only
import '@fontsource-variable/geist-mono/wght.css'; // 'Geist Mono Variable'
import '@fontsource/instrument-serif/latin-400-italic.css'; // 'Instrument Serif', italic, latin only
import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from './components/ui/shadcn/tooltip';
import { AuraDefs } from './components/ai/Spark';
import { AuthGate } from './components/auth/AuthGate';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider delayDuration={400} skipDelayDuration={150}>
      <AuraDefs />
      <AuthGate>
        <App />
      </AuthGate>
    </TooltipProvider>
  </StrictMode>,
);
