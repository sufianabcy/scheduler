import { render } from 'preact';
import { App } from './App.jsx';
import { applyTheme } from './theme.js';
import './theme.css';
import './app.css';

applyTheme();
render(<App />, document.getElementById('app'));

// The service worker makes the app installable and lets it open offline. Only in the built app:
// in development it would cache files while you're editing them.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}
