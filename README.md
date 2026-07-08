# Order Service - Grupo 5

Este repositorio corresponde al microservicio de pedidos del Grupo 5 dentro de una arquitectura de microservicios del marketplace. El servicio se encarga de gestionar el ciclo de vida de las órdenes, incluyendo creación, consulta, actualización de estado y coordinación con otros servicios del sistema.

---

## Propósito del servicio

El Order Service tiene como responsabilidad central administrar pedidos en nombre del cliente. Su flujo principal incluye:

- Crear una orden a partir de los productos solicitados.
- Validar que el usuario esté autenticado.
- Reservar stock en el servicio de inventario.
- Escuchar eventos de pago y despacho.
- Actualizar el estado de la orden conforme avanza el proceso.

---

## Arquitectura

El servicio está construido con Node.js y Express, y utiliza:

- PostgreSQL para persistir órdenes, ítems, historial y eventos.
- RabbitMQ para la comunicación asíncrona con otros microservicios.
- Axios para integraciones síncronas vía HTTP.

---

## Integraciones con otros grupos

### Grupo 2 - Autenticación

Antes de crear una orden, el servicio valida el token del usuario mediante una llamada al endpoint de autenticación del Grupo 2.

- Endpoint usado: `/auth/validate`
- Se obtiene el `business_user_id` para asociarlo a la orden.

### Grupo 7 - Inventario

Cuando se crea una orden, el servicio contacta al Grupo 7 para reservar stock.

- Reserva de stock: `/inventory/reserve`
- Liberación de reserva: `/inventory/release`
- Confirmación de reserva: `/inventory/confirm`

### Grupo 6 - Pagos

El servicio no depende de pagos de forma síncrona, sino que reacciona a eventos provenientes del Grupo 6 mediante RabbitMQ.

- Si el pago es aprobado, la orden pasa a `PAID`.
- Si el pago es rechazado, la orden pasa a `FAILED`.

### Grupo 8 - Despacho

El servicio también escucha eventos del Grupo 8 para actualizar el estado final del pedido.

- Si el pedido se entrega, pasa a `DELIVERED`.
- Si hay un fallo en el despacho, pasa a `FAILED`.

---

## RabbitMQ

RabbitMQ se usa para la integración asíncrona entre servicios.

### Función del servicio en RabbitMQ

- Publica eventos desde la tabla `outbox_events`.
- Consume eventos desde una cola dedicada llamada `g5-order-service`.
- Procesa mensajes relacionados con pagos y despacho.

### Patrón Outbox

El servicio implementa un patrón Outbox para asegurar que los eventos de negocio se registren en la base de datos antes de publicarse en RabbitMQ, reduciendo inconsistencias entre servicios.

---

## Endpoints principales

### Salud del servicio

- `GET /health`: verifica si el servicio y la base de datos están funcionando.

### Gestión de pedidos

- `POST /orders`: crea una orden.
- `GET /orders`: lista órdenes paginadas por usuario.
- `GET /orders/:id`: obtiene una orden específica.
- `PATCH /orders/:id`: actualiza el estado de una orden.

---

## Variables de entorno

El servicio requiere variables como:

```env
PORT=3000
DATABASE_URL=...
RABBITMQ_URL=...
G2_BASE_URL=...
G7_BASE_URL=...
G6_BASE_URL=...
G8_BASE_URL=...
```

---

## Ejecución local

```bash
cd mock-api
npm install
npm start
```

El servicio quedará disponible en el puerto configurado por `PORT`.

---

## Resumen

Este repositorio representa el microservicio de pedidos del Grupo 5. Su rol es coordinar la creación y evolución de las órdenes, integrándose con autenticación, inventario, pagos y despacho mediante HTTP y RabbitMQ.
