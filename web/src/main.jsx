import { render } from 'preact';
import { App } from './App.jsx';
import { applyTheme } from './theme.js';
import './theme.css';
import './app.css';

applyTheme();
render(<App />, document.getElementById('app'));

// The service worker shows notifications, makes the app installable and lets it open offline. It is registered
// straight away (not on 'load') so notifications can be switched on at once. In development it's registered
// with ?dev, which turns its file caching off so edits show up immediately.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(import.meta.env.PROD ? '/sw.js' : '/sw.js?dev').catch((err) => {
    console.error('Service worker registration failed', err);
  });
}
