// Runs once on first start (empty volume). Creates a least-privilege application user
// limited to readWrite on the application database.
const dbName = process.env.MONGO_DB || 'repoinsight';
db.getSiblingDB(dbName).createUser({
  user: process.env.MONGO_APP_USER,
  pwd: process.env.MONGO_APP_PASSWORD,
  roles: [{ role: 'readWrite', db: dbName }],
});
