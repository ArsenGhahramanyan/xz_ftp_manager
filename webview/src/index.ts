// Import styles
import './styles/variables.css';
import './styles/main.css';
import './styles/dualPane.css';
import './styles/toolbar.css';
import './styles/fileList.css';
import './styles/transferPanel.css';
import './styles/contextMenu.css';
import './styles/dialogs.css';

// Import modules
import { Store } from './state/Store';
import { AppState, createInitialState } from './state/AppState';
import { MessageBus } from './services/MessageBus';
import { App } from './App';

// Bootstrap
const store = new Store<AppState>(createInitialState());
const bus = new MessageBus();
const app = new App(store, bus);

const root = document.getElementById('app') || document.body;
app.mount(root);
