MI CHAT - CÁMARA DE ADMINISTRACIÓN EN SEGUNDO PLANO

Esta versión separa el transporte de cámara del WebView y lo mueve a un Foreground Service Android con WebRTC nativo.

CAMBIOS CLAVE
- CameraForegroundService mantiene Socket.IO y WebRTC nativos cuando la Activity se destruye o se elimina de Recientes.
- El servidor añade cameraAuthenticate y un mapa separado de sockets de cámara para no echar al WebView de la sesión normal.
- Admin sigue usando la misma interfaz y señalización WebRTC.
- El WebView Android detecta el modo nativo y no intenta abrir otra cámara al mismo tiempo.

PASOS
1. Despliega el contenido web actualizado (server.js + public + package.json/package-lock) en GitHub/Render.
2. Abre el proyecto Android en Android Studio.
3. Sincroniza Gradle y acepta la descarga de las dependencias.
4. Instala/genera la APK.
5. Abre Mi Chat, concede el permiso de cámara y activa el permiso de supervisión de cámara.
6. Deja Mi Chat abierta unos segundos para que se inicie el Foreground Service.
7. Puedes quitar Mi Chat de Recientes; el servicio queda preparado.
8. Desde Admin solicita la cámara.

REQUISITOS
- Android 14+ recomienda mantener las restricciones de Foreground Service en cuenta.
- El permiso de cámara debe concederse mientras Mi Chat está visible.
- Android muestra una notificación permanente del servicio.
- Forzar detención desde Ajustes del sistema puede detener el servicio.

Dependencias Android nuevas:
- io.socket:socket.io-client:2.1.2
- com.infobip:google-webrtc:1.0.48246t

URL del servidor:
https://michat-2-0-x7mz.onrender.com/
