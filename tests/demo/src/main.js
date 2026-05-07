import { render } from 'pota'

// Side-effect import: spins up the angelia.io Client and wires every
// server event into the reactive state. Has to run before render so
// the connect handler is in place by the time the session opens.
import './connection.js'

import { App } from './components/App.js'

render(App, document.body)
