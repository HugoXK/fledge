import { loadConfig } from '../src/config.js'
import { openStore } from '../src/db.js'

const [login = '', role = ''] = process.argv.slice(2)
if (login === '' || (role !== 'admin' && role !== 'user')) {
  console.error('usage: npm run role:set -- <github-login> <admin|user>')
  process.exit(1)
}

const config = loadConfig()
const store = openStore(config.dbPath)
try {
  const user = store.userByLogin(login)
  if (user === undefined) throw new Error(`user not found: ${login}`)
  if (user.role === 'superadmin') throw new Error('the super admin role cannot be changed from this script')
  store.setUserRole(user.id, role)
  store.audit(null, 'admin.role', `login=${user.login} role=${role} by cli`)
  console.log(`${user.login}: ${user.role} -> ${role}`)
} finally {
  store.close()
}
