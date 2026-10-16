import { useEffect, useState } from 'preact/hooks';

// One short message at a time, shown at the bottom of the screen.
let listener = () => {};
let timer;

export function toast(message) {
  clearTimeout(timer);
  listener(message);
  timer = setTimeout(() => listener(null), 3500);
}

export function useToast() {
  const [message, setMessage] = useState(null);
  useEffect(() => {
    listener = setMessage;
    return () => {
      listener = () => {};
    };
  }, []);
  return message;
}
