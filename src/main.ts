import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

// 先挂界面，设置在 App 里异步读（IndexedDB 出问题也不至于白屏）
export default mount(App, { target: document.getElementById('app')! });
