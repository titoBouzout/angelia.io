/**
 * Per-tab identity. The name is generated once and persisted in
 * `sessionStorage` so reloads keep the same handle, but a fresh tab
 * gets a fresh name.
 */

let savedName = sessionStorage.getItem('demo-name')
if (!savedName) {
	savedName = 'guest-' + Math.random().toString(36).slice(2, 6)
	sessionStorage.setItem('demo-name', savedName)
}

export const name = savedName

export const initialRoom = (
	location.hash.replace(/^#/, '') || 'main'
).toLowerCase()
