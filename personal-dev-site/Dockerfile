FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html styles.css app.js content-plan.md /usr/share/nginx/html/
COPY assets /usr/share/nginx/html/assets
COPY third-party /usr/share/nginx/html/third-party

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
