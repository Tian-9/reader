import { mount } from 'svelte';
import '../../src/app.css';
import Demo from './Demo.svelte';

mount(Demo, { target: document.getElementById('app')! });
