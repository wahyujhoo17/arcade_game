module.exports = {
    apps: [
        {
            name: 'arcade-game',
            script: 'server.js',
            env_production: {
                NODE_ENV: 'production',
                PORT: 4000,
            },
        },
    ],
}
