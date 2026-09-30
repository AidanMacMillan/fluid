import { mount } from 'svelte'
import './assets/main.css'
import HistoryApp from './HistoryApp.svelte'
export default mount(HistoryApp, { target: document.getElementById('history')! })
