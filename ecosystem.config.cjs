module.exports = {
	apps: [
		{
			name: "hive-backend",
			script: "./dist/server.js",
			cwd: __dirname,
			interpreter: "node",
			exec_mode: "fork",
			instances: 2,
			env: {
				NODE_ENV: "production",
			},
		},
		{
			name: "hive-workers",
			script: "./dist/init.workers.js",
			cwd: __dirname,
			interpreter: "node",
			exec_mode: "fork",
			instances: 1,
			env: {
				NODE_ENV: "production",
			},
		},
	],
};
