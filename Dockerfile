# Use the official Nginx image as the base
FROM nginx:alpine

# Copy your game files (HTML, JS, CSS, assets) into the Nginx server directory
# Replace "public" with the actual name of your folder containing index.html
COPY booster-board.html /usr/share/nginx/html

COPY . /usr/share/nginx/html/

EXPOSE 80