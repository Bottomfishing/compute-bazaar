FROM python@sha256:aa943ce411423c7582288f18707ff66eddcbaeb510502d747a72aeb34f30d159
COPY requirements.lock /opt/bazaar/requirements.lock
RUN --mount=type=bind,source=wheels,target=/wheels pip install --no-cache-dir --no-index --find-links=/wheels --require-hashes -r /opt/bazaar/requirements.lock
COPY numpy.lock /opt/bazaar/numpy.lock
RUN --mount=type=bind,source=numpy-wheels,target=/wheels pip install --no-cache-dir --no-index --find-links=/wheels --require-hashes -r /opt/bazaar/numpy.lock
COPY gpu-check.py /opt/bazaar/gpu-check.py
