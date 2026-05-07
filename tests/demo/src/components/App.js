import { xml } from 'pota/xml'

import { Header } from './Header.js'
import { RoomBar } from './RoomBar.js'
import { ChatLog } from './ChatLog.js'
import { ChatForm } from './ChatForm.js'
import { Roster } from './Roster.js'
import { FanOut } from './FanOut.js'
import { Stats } from './Stats.js'
import { Connection } from './Connection.js'

// Custom components have to be registered before the first `xml`...``
// invocation that uses them. Pota's built-ins (`<For/>`, `<Show/>`,
// etc.) are pre-registered by the default xml instance, so only the
// custom components below need a `define`.
xml.define({
	Header,
	RoomBar,
	ChatLog,
	ChatForm,
	Roster,
	FanOut,
	Stats,
	Connection,
})

export const App = () => xml`
	<Header />
	<RoomBar />
	<ChatLog />
	<ChatForm />
	<Roster />
	<FanOut />
	<Stats />
	<Connection />
`
