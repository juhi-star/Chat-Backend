import { app } from './app';
import { config } from './config';
import './firebase';

app.listen(config.port, () => console.log(`Chat backend listening on :${config.port}`));
