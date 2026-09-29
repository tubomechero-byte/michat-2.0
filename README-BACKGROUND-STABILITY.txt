MEJORAS DE ESTABILIDAD EN SEGUNDO PLANO

- El servicio de cámara mantiene un foreground service de tipo camera.
- Mientras la cámara está activa, usa un PARTIAL_WAKE_LOCK para evitar que el CPU se duerma durante la transmisión.
- Socket.IO se comprueba cada 5 segundos y se reconecta aunque la sesión de cámara ya esté activa.
- Al perder la conexión se programa una reconexión automática.
- Al quitar Mi Chat de Recientes se vuelve a comprobar la conexión.

Importante: Android y los fabricantes pueden seguir terminando procesos por restricciones del sistema, ahorro de batería o "Forzar detención". El servicio no puede saltarse esas políticas.
