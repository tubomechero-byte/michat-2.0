MI CHAT - CÁMARA NATIVA EN SEGUNDO PLANO

Qué hace:
- La captura de supervisión de cámara usa WebRTC nativo de Android, no el WebView.
- CameraForegroundService mantiene Socket.IO + WebRTC cuando la Activity se destruye o se quita Mi Chat de Recientes.
- El servidor tiene un transporte Socket.IO separado para la cámara, para no echar al WebView de la sesión normal del usuario.

Para usarlo:
1. Instala la app y concede el permiso de CÁMARA cuando Android lo solicite.
2. Dentro de Mi Chat activa "Permitir solicitudes de cámara del administrador".
3. Mantén Mi Chat abierta unos segundos para que se inicie el servicio de primer plano.
4. Ya puedes cerrar/minimizar Mi Chat; el servicio seguirá preparado.
5. El Admin solicita la cámara. El servicio nativo recibe la solicitud, abre la cámara y entrega vídeo por WebRTC al Admin.
6. Android mantiene una notificación visible mientras el servicio está activo y mientras se comparte la cámara.

Importante:
- Android 14+ requiere que el Foreground Service de cámara se cree mientras la app está visible; por eso el paso 3 es necesario.
- El sistema seguirá mostrando el indicador/permiso de cámara correspondiente.
- Si el usuario fuerza la detención de la app desde Ajustes del sistema, Android puede detener el servicio.

Dependencias:
- io.socket:socket.io-client:2.1.2
- com.infobip:google-webrtc:1.0.48246t

URL:
https://michat-2-0-x7mz.onrender.com/
