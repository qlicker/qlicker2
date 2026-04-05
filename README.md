# Qlicker

Qlicker is a classroom response system (clicker) for higher education. It allows professors to create interactive sessions with questions (multiple choice, true/false, short answer, multi-select, numerical) that students can answer in real-time, as well as timed quizzes. It includes grading, group management, video chat features, question libraries, and SSO integration.

This repository is the new home for Qlicker, migrated from the original [MeteorJS implementation](https://github.com/qlicker/qlicker) to a modern **Fastify + React** stack. The code is being moved from [ryanmartinneutrino/qlicker-1](https://github.com/ryanmartinneutrino/qlicker-1).

## Repository Structure

Once the migration code is brought in, the repository will be structured as follows:

```
├── server/                                 # Fastify backend
├── client/                                 # React frontend (Vite)
├── ssoserver/                              # Isolated local SimpleSAMLphp IdP for SSO smoke tests
├── load-testing/                           # k6 load testing scenario + seed script
├── production_setup/                       # Self-contained production deployment package
├── scripts/                                # Setup and utility scripts
├── docs/                                   # Developer and user documentation
├── docker-compose.yml                      # Docker orchestration (development)
└── .env.example                            # Environment variable template
```

## Tech Stack

- **Backend:** [Fastify](https://fastify.dev/) (Node.js)
- **Frontend:** [React](https://react.dev/) + [Vite](https://vitejs.dev/)
- **Database:** MongoDB
- **Cache / Pub-Sub:** Redis (optional; enables multi-instance WebSocket pub/sub)
- **Auth:** Session-based with optional SAML SSO

## Prerequisites

- Node.js >= 20.x
- npm >= 10.x
- MongoDB >= 6.x (or Docker)
- Redis >= 7.x (optional — or Docker)

## Status

> **Note:** The application code is being migrated into this repository. See [ryanmartinneutrino/qlicker-1](https://github.com/ryanmartinneutrino/qlicker-1) for the current working implementation.

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
