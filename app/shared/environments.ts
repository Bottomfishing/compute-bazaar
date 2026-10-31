export const environmentTemplates=['python','notebook','pytorch'] as const;
export type EnvironmentTemplate=typeof environmentTemplates[number];
export const environmentLabels:Record<string,string>={python:'Python 轻量终端',notebook:'JupyterLab + NumPy',pytorch:'PyTorch 2.10 · CUDA 12.8 终端'};
export const pytorchImage='bazaar-pytorch:2.10.0-cu128';
