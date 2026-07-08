# Resumen del Order Service (Grupo 5)

Este servicio es el componente de pedidos del ecosistema de microservicios del marketplace. Su responsabilidad principal es gestionar el ciclo de vida de una orden, desde la creación hasta los cambios de estado, integrándose con otros grupos para validar usuarios, reservar inventario y reaccionar a eventos de pago y despacho.

## 1. Propósito general

El archivo server.js implementa un API REST en Express que expone operaciones para:

- Crear órdenes.
- Listar órdenes por usuario.
- Consultar una orden por la ID del pedido.
- Actualizar el estado de una orden.
- Verificar el estado del servicio.

Todo esto se apoya en una base de datos PostgreSQL y en RabbitMQ para la comunicación asíncrona con otros servicios.

## 2. Integración con el Grupo 2 (Autenticación)

Cuando llega una petición para crear una orden, el servicio valida el token enviado por el cliente llamando al endpoint de autenticación del Grupo 2.

### Qué hace

- Envía la solicitud a `/auth/validate`.
- Pasa el header `Authorization` con el token.
- Espera recibir el perfil del usuario, especialmente el campo `business_user_id`.

### Importancia

Esto garantiza que solo usuarios autenticados puedan crear pedidos y que el sistema conozca quién está realizando la operación.

## 3. Integración con el Grupo 7 (Inventario)

El Grupo 5 integra con el Grupo 7 para manejar el stock durante la creación de una orden.

### Operaciones implementadas

- Reserva de stock: `POST /inventory/reserve`
- Liberación de reserva: `POST /inventory/release`
- Confirmación de reserva: `POST /inventory/confirm`

### Flujo

1. Se recibe la solicitud de creación de una orden.
2. Se envía la reserva de stock al servicio de inventario.
3. Si la reserva se acepta, se crea la orden en la base de datos.
4. Si ocurre un error, se libera la reserva para no dejar inventario bloqueado innecesariamente.

## 4. Integración con RabbitMQ

RabbitMQ se usa como canal de comunicación asíncrona entre servicios. En este archivo el servicio actúa tanto como productor como consumidor de eventos.

### 4.1 Productor

El servicio publica eventos desde la tabla `outbox_events`.

Esto sigue un patrón conocido como Outbox, que permite:

- registrar el evento en la base de datos primero,
- luego enviarlo a RabbitMQ,
- y reducir el riesgo de inconsistencias entre sistemas.

### 4.2 Consumidor

El servicio crea una cola llamada `g5-order-service` y se suscribe a eventos de interés.

Los eventos que procesa incluyen:

- `payment.approved`
- `payment.rejected`
- `InventoryReleased`
- `ShipmentDelivered`
- `ShipmentFailed`

### 4.3 Relación con otros grupos

- Con el Grupo 6 (Pagos): escucha eventos de aprobación o rechazo de pagos y actualiza el estado de la orden.
- Con el Grupo 8 (Despacho): escucha eventos de entrega o fallo de despacho y modifica el estado del pedido.

## 5. Integración con el Grupo 6 (Pagos)

Aunque el servicio no llama directamente al servicio de pagos en cada operación, sí reacciona a eventos que llegan por RabbitMQ desde ese grupo.

### Ejemplo

- Si un pago es aprobado, la orden pasa a `PAID`.
- Si un pago es rechazado, la orden pasa a `FAILED`.

## 6. Integración con el Grupo 8 (Despacho)

El servicio también escucha eventos provenientes del grupo de despacho para actualizar la orden.

### Ejemplo

- Si el pedido se entrega, cambia a `DELIVERED`.
- Si hay un problema en el despacho, cambia a `FAILED`.

## 7. Gestión de estados de la orden

El sistema define una máquina de estados para controlar transiciones válidas, por ejemplo:

- `STOCK_RESERVED`
- `PAYMENT_PENDING`
- `PAID`
- `READY_TO_SHIP`
- `SHIPPED`
- `DELIVERED`
- `FAILED`
- `CANCELLED`

Esto evita que una orden avance a estados inválidos.

## 8. Endpoints principales

### Health check

- `GET /health`: verifica si el servicio y la base de datos están disponibles.

### Pedidos

- `POST /orders`: crea una orden.
- `GET /orders`: lista órdenes paginadas por usuario.
- `GET /orders/:id`: consulta una orden específica.
- `PATCH /orders/:id`: actualiza el estado de una orden.

## 9. Resumen corto

En síntesis, este servicio actúa como el orquestador del ciclo de vida de los pedidos. Coordina autenticación, inventario, pagos y despacho usando:

- HTTP para integraciones síncronas con G2 y G7.
- RabbitMQ para integraciones asíncronas con G6 y G8.
- PostgreSQL para persistir órdenes, items, historial y eventos.
