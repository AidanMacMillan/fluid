import { mount } from 'svelte'
import './assets/main.css'
import SidebarPanelApp from './SidebarPanelApp.svelte'

mount(SidebarPanelApp, { target: document.getElementById('sidebar')! })
