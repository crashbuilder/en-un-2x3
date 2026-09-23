FROM node:20-alpine

# Establecer directorio de trabajo
WORKDIR /app

# Instalar dependencias del sistema necesarias para compilar paquetes nativos
RUN apk add --no-cache python3 make g++

# Copiar archivos de dependencias
COPY package.json package-lock.json* ./

# Instalar dependencias
RUN npm install

# Copiar código fuente y configuración
COPY . .

# Exponer el puerto del agente (por si hay un webhook)
EXPOSE 3000

# Comando para iniciar el framework y compilar las herramientas (simulado con ts-node)
CMD ["npm", "start"]
