# Mini Marketplace — Documentación de equipos

Aplicación fullstack de marketplace construida en arquitectura de microservicios. Cada grupo es responsable de un servicio o del frontend. Este documento explica cómo debe trabajar cada equipo dentro de su carpeta.

---

## Mapa de grupos

| Grupo | Carpeta | Responsabilidad | Puerto |
|---|---|---|---|
| G1 | `frontend/` | Interfaz de usuario (React + Vite) | 5173 |
| G2 ★ | `services/identidad/` | Autenticación y gestión de usuarios | 3001 |
| G3 | `services/catalogo/` | Catálogo de productos | 3002 |
| G4 | `services/carro/` | Carrito de compras | 3003 |
| G5 | `services/pedidos/` | Gestión de órdenes | 3004 |
| G6 | `services/pagos/` | Procesamiento de pagos | 3005 |
| G7 | `services/inventario/` | Control de stock | 3006 |
| G8 | `services/despacho/` | Envíos y despacho | 3007 |
| G9 | `services/notificaciones/` | Notificaciones (email / push) | 3008 |
| G10 | `services/reporteria/` | Reportes y analíticas | 3009 |
| G11 | `services/chatbot/` | Chatbot de soporte al cliente | 3010 |

> ★ El servicio `identidad` es la referencia de estructura. Si no saben cómo organizar su servicio, mírenlo a él.

---

## Estructura general del proyecto

```
mini-marketplace/
├── frontend/
├── services/
│   ├── identidad/
│   ├── catalogo/
│   ├── carro/
│   ├── pedidos/
│   ├── pagos/
│   ├── inventario/
│   ├── despacho/
│   ├── notificaciones/
│   ├── reporteria/
│   └── chatbot/
└── docker-compose.yml
```

---

## Estructura estándar de un servicio (Node.js + TypeScript)

Todos los servicios de backend deben seguir esta estructura. Tomen como referencia `services/identidad/`:

```
services/<nombre>/
├── src/
│   ├── index.ts              # Entry point — crea el servidor y lo arranca
│   ├── config/
│   │   └── supabase.ts       # Cliente de Supabase u otra config global
│   ├── routes/
│   │   └── <nombre>.routes.ts   # Define las rutas del servicio
│   ├── controllers/
│   │   └── <nombre>.controller.ts  # Lógica de cada endpoint
│   └── middlewares/
│       └── auth.middleware.ts   # Validación de JWT u otros guards
├── .env                      # Variables locales (NO commitear)
├── .env.example              # Plantilla de variables (SÍ commitear)
├── package.json
├── tsconfig.json
├── Dockerfile
└── .gitignore
```

### Qué va en cada archivo

| Archivo | Qué debe tener |
|---|---|
| `index.ts` | Crear app Express, registrar middlewares globales (cors, json), montar rutas, llamar a `app.listen()` |
| `config/supabase.ts` | Inicializar y exportar el cliente de Supabase |
| `routes/*.routes.ts` | Solo definir rutas: `router.get('/ruta', controller.metodo)` |
| `controllers/*.controller.ts` | Lógica de negocio de cada endpoint: recibir request, procesar, responder |
| `middlewares/auth.middleware.ts` | Verificar JWT antes de pasar al controller |

---

## Variables de entorno

Cada servicio tiene su propio `.env`. Copiar el ejemplo y completar:

```bash
cp services/<nombre>/.env.example services/<nombre>/.env
```

Plantilla mínima para cualquier servicio backend:

```env
PORT=30XX                        # Ver tabla de puertos arriba
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

**Nunca committear el `.env` con valores reales.** El `.env.example` con las claves vacías sí va al repositorio.

---

## Cómo levantar un servicio en desarrollo

```bash
cd services/<nombre>
npm install
npx tsx src/index.ts
```

Con Docker:

```bash
cd services/<nombre>
docker build -t marketplace-<nombre> .
docker run -p 30XX:30XX --env-file .env marketplace-<nombre>
```

Para levantar todo el sistema junto:

```bash
docker-compose up
```

---

## Frontend (G1)

**Carpeta:** `frontend/`  
**Stack:** React 19 + Vite 8 + Supabase JS

```bash
cd frontend
npm install
npm run dev        # dev server en http://localhost:5173
npm run build      # build de producción
```

El frontend consume los servicios de backend vía HTTP. Cada servicio expone su propio endpoint.

**Variables de entorno** (`frontend/.env.local`):

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_API_IDENTIDAD=http://localhost:3001
VITE_API_CATALOGO=http://localhost:3002
# ... agregar los demás según necesiten
```

---

## Git — reglas básicas

1. **Nunca trabajar directo en `main`.** Crear siempre una rama propia.
2. **Cada grupo trabaja solo en su carpeta.** No tocar carpetas de otros grupos.
3. Nombrar las ramas con el prefijo del tipo de cambio:

```bash
git checkout -b feat/login-con-supabase
git checkout -b fix/error-stock-negativo
git checkout -b docs/actualizar-readme
```

4. Hacer commits pequeños y descriptivos:

```bash
git commit -m "feat: agregar endpoint POST /auth/login"
git commit -m "fix: validar que el stock no quede negativo"
```

5. Para incorporar cambios a `main`, abrir un **Pull Request** en GitHub y pedir revisión. Ver [`CONTRIBUTING.md`](CONTRIBUTING.md) para el flujo completo.

---

## Stack común (servicios backend)

| Herramienta | Versión |
|---|---|
| Node.js | 20 LTS |
| TypeScript | 6 |
| Express | 5 |
| Supabase JS | 2 |
| tsx (dev runner) | última |
